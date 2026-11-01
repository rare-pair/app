import { createDb, getUploadQuota, insertUpload } from "@archive/db";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { uploadPage } from "./pages";
import { presignPut } from "./presign";
import { limitFor, quotaSpent } from "./quota";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { isSameOrigin } from "./signin";
import { TURNSTILE_ACTIONS, verifyTurnstile } from "./turnstile";
import { EPUB_TYPE, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./upload-limit";

// ARCHITECTURE, Ingestion pipeline, step 1. The upload page's script calls
// `POST /uploads` once per file, with a fresh Turnstile token each time, and PUTs
// the file straight to R2: no byte of it passes through this Worker.

type UploadContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

// How long a presigned URL works: 10 minutes.
const UPLOAD_URL_SECONDS = 600;

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
 * `POST /uploads`: an `uploads` row and a presigned PUT URL for it, as JSON
 * `{ id, url }`, or `{ error }` for the page to show. The body is a plain form:
 * `size`, the declared bytes, and `cf-turnstile-response`.
 */
export async function requestUpload(c: UploadContext) {
  const refuse = (status: 400 | 401 | 413 | 503, error: string) =>
    c.json({ error }, status, NO_STORE);

  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");
  // U5: the per-user upload rate limit goes here, before the body is read.

  const form = await readForm(c.req.raw);
  if (form === null) return refuse(413, "That request was too large. Please try again.");

  // Before Turnstile, so a size that can't pass spends no token and no siteverify call.
  const size = form.get("size") ?? "";
  if (!SIZE.test(size)) {
    return refuse(400, "The file's size is missing or not a whole number. Please try again.");
  }
  const bytes = Number(size);
  if (bytes > MAX_UPLOAD_BYTES) {
    return refuse(413, `That file is over the ${MAX_UPLOAD_MB} MB limit, so it can't be uploaded.`);
  }

  const turnstile = await verifyTurnstile(form.get("cf-turnstile-response"), {
    secret: c.env.TURNSTILE_SECRET_KEY,
    hostname: new URL(c.req.url).hostname,
    action: TURNSTILE_ACTIONS.upload,
    remoteIp: c.req.header("cf-connecting-ip") ?? null,
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
  // One connection serves the quota read and the row.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // The quota is counted when an upload is confirmed (upload-complete.ts), which is where
    // the hard cap holds. Asking is refused early once today's is spent, so nobody is sent to
    // upload a file that confirm would refuse. Nothing is counted here.
    const quota = await getUploadQuota(db, user.id);
    if (quota !== null && quota.usedToday >= limitFor(quota.role, c.env)) return quotaSpent(c);

    // The key is ours alone: nothing in it comes from the request.
    const id = crypto.randomUUID();
    const key = `uploads/${id}`;
    // Signed before the row is written, so a signing fault leaves no row behind.
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
    await insertUpload(db, { id, userId: user.id, r2Key: key, bytes });
    return c.json({ id, url }, 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
