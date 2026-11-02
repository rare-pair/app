import { createDb, getUploadQuota, insertUpload } from "@archive/db";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { uploadPage } from "./pages";
import { presignPut } from "./presign";
import { limitFor, quotaShort, quotaSpent } from "./quota";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import {
  ipKey,
  isLimited,
  tooManyRequestsJson,
  UPLOAD_WINDOW_SECONDS,
  userKey,
} from "./rate-limit";
import { isSameOrigin } from "./signin";
import { TURNSTILE_ACTIONS, verifyTurnstile } from "./turnstile";
import { EPUB_TYPE, MAX_BATCH_FILES, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./upload-limit";

// ARCHITECTURE, Ingestion pipeline, step 1. The upload page's script calls
// `POST /uploads` once for all the files picked, with one Turnstile token and a
// `size` for each, and PUTs each file straight to R2: no byte of one passes through
// this Worker.

type UploadContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

// How long a presigned URL works: 10 minutes.
const UPLOAD_URL_SECONDS = 600;

const TOO_FAST = "You're uploading too fast. Please wait a moment and try again.";

// A declared size in bytes, as the plain decimal form only: Number() alone also
// reads "0x10", "1e3" and " 12". No empty epub exists, so zero isn't one either.
const SIZE = /^[1-9][0-9]*$/;

// No cache keeps a reply: a URL in one can write to the bucket.
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * `GET /upload`: the upload page, or sign in first and come back. Neither is
 * cached: which one is sent depends on the cookie, and the page can carry a
 * refreshed session cookie.
 */
export const showUpload = (c: UploadContext) => {
  c.header("Cache-Control", NO_STORE["Cache-Control"]);
  return c.var.session === null
    ? c.redirect(`/login?next=${encodeURIComponent("/upload")}`, 302)
    : c.html(uploadPage(c.get("nonce"), c.env.TURNSTILE_SITE_KEY));
};

/**
 * Refuses a `POST /uploads` from anywhere but a page on the site, with a JSON 403.
 * It runs before the session middleware, so a refused request costs no lookup.
 */
export const sameOriginUpload: MiddlewareHandler = async (c, next) => {
  if (!isSameOrigin(c.req.raw.headers)) {
    return c.json({ error: "That request didn't come from rarepair." }, 403, NO_STORE);
  }
  await next();
};

/**
 * `POST /uploads`: an `uploads` row and a presigned PUT URL for each file, as JSON
 * `{ id, url }` for one file or `{ uploads: [{ id, url }, ...] }` for several, or
 * `{ error }` for the page to show. The body is a plain form: `size`, the declared
 * bytes, once per file, and `cf-turnstile-response`.
 */
export async function requestUpload(c: UploadContext) {
  const refuse = (status: 400 | 401 | 413 | 503, error: string) =>
    c.json({ error }, status, NO_STORE);

  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");
  // The user first, so one user over their limit can't spend the budget of an address others share.
  // Counted before the body is read, so a flood costs no body, no Turnstile check and no row.
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  if (
    (await isLimited(c.env.UPLOAD_USER_LIMIT, await userKey("upload", user.id))) ||
    (await isLimited(c.env.UPLOAD_IP_LIMIT, await ipKey("upload", clientIp)))
  ) {
    return tooManyRequestsJson(c, TOO_FAST, UPLOAD_WINDOW_SECONDS);
  }

  const form = await readForm(c.req.raw);
  if (form === null) return refuse(413, "That request was too large. Please try again.");

  // One `size` per file. A batch over the cap is refused outright.
  const sizes = form.getAll("size");
  if (sizes.length > MAX_BATCH_FILES) {
    return refuse(413, `You can upload ${MAX_BATCH_FILES} files at a time. Please pick fewer.`);
  }

  // Before Turnstile, so a size that can't pass spends no token and no siteverify call.
  // Every size is checked before any row is written, so a bad one refuses the whole batch.
  const declared: number[] = [];
  for (const size of sizes.length === 0 ? [""] : sizes) {
    if (!SIZE.test(size)) {
      return refuse(400, "The file's size is missing or not a whole number. Please try again.");
    }
    declared.push(Number(size));
  }
  if (declared.some((bytes) => bytes > MAX_UPLOAD_BYTES)) {
    return refuse(
      413,
      `${declared.length === 1 ? "That file is" : "A file is"} over the ${MAX_UPLOAD_MB} MB limit, so it can't be uploaded.`,
    );
  }

  // Each file counts once against both limits. The first of each was spent above, so a
  // flood still costs no body; the rest are spent here, once the sizes are known to be
  // good (a malformed batch spends no more) and before Turnstile, the user first.
  for (let spent = 1; spent < declared.length; spent++) {
    if (await isLimited(c.env.UPLOAD_USER_LIMIT, await userKey("upload", user.id))) {
      return tooManyRequestsJson(c, TOO_FAST, UPLOAD_WINDOW_SECONDS);
    }
  }
  for (let spent = 1; spent < declared.length; spent++) {
    if (await isLimited(c.env.UPLOAD_IP_LIMIT, await ipKey("upload", clientIp))) {
      return tooManyRequestsJson(c, TOO_FAST, UPLOAD_WINDOW_SECONDS);
    }
  }

  const turnstile = await verifyTurnstile(form.get("cf-turnstile-response"), {
    secret: c.env.TURNSTILE_SECRET_KEY,
    hostname: new URL(c.req.url).hostname,
    action: TURNSTILE_ACTIONS.upload,
    remoteIp: clientIp,
  });
  if (turnstile === "failed") {
    return refuse(400, "The anti-spam check did not pass. Please try again.");
  }
  if (turnstile === "unavailable") {
    return refuse(
      503,
      "The anti-spam check is not answering just now. Please try again in a minute.",
    );
  }
  // One connection serves the quota read and the rows.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // The quota is counted when an upload is confirmed (upload-complete.ts), which is where
    // the hard cap holds. Asking is refused early when the files asked for are more than
    // today's quota has left, so nobody is sent to upload a file that confirm would refuse.
    // Nothing is counted here.
    const quota = await getUploadQuota(db, user.id);
    if (quota !== null) {
      const left = Math.max(0, limitFor(quota.role, c.env) - quota.usedToday);
      if (declared.length > left) {
        return left === 0 ? quotaSpent(c) : quotaShort(c, left);
      }
    }

    // The keys are ours alone: nothing in them comes from the request.
    const files = await Promise.all(
      declared.map(async (bytes) => {
        const id = crypto.randomUUID();
        const key = `uploads/${id}`;
        // Every URL is signed before any row is written, so a signing fault leaves no row behind.
        const url = await presignPut({
          accountId: c.env.R2_ACCOUNT_ID,
          bucket: c.env.R2_BUCKET,
          accessKeyId: c.env.R2_ACCESS_KEY_ID,
          secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
          key,
          contentType: EPUB_TYPE,
          expiresSeconds: UPLOAD_URL_SECONDS,
          now: new Date(),
        });
        return { id, key, bytes, url };
      }),
    );
    // All the rows or none.
    await db.transaction().execute(async (trx) => {
      for (const { id, key, bytes } of files) {
        await insertUpload(trx, { id, userId: user.id, r2Key: key, bytes });
      }
    });
    const [only] = files;
    return c.json(
      files.length === 1 && only !== undefined
        ? { id: only.id, url: only.url }
        : { uploads: files.map(({ id, url }) => ({ id, url })) },
      200,
      NO_STORE,
    );
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
