import {
  createDb,
  getUploadOf,
  getUploadQuota,
  recordUploadHash,
  refundUploadQuota,
  rejectOverQuotaUpload,
  rejectOversizedUpload,
  useUploadQuota,
} from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { NO_STORE } from "./login";
import { limitFor, quotaSpent } from "./quota";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./upload-limit";

// ARCHITECTURE, Ingestion pipeline, step 3. The upload page's script calls
// `POST /uploads/:id/complete` once the browser's PUT to R2 has finished. The object is
// read through the BUCKET binding, which is the same bucket the presigned URL wrote to.

type CompleteContext = Context<
  {
    Bindings: Bindings;
    Variables: SecurityVariables & SessionVariables;
  },
  "/uploads/:id/complete"
>;

// Upload ids are random text bounded at 64 characters (apps/ingest/src/message.ts). Nothing
// longer, or holding a NUL, which Postgres refuses, can name an upload.
const MAX_ID = 64;

/** The lowercase hex of a SHA-256 digest. */
const hex = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `POST /uploads/:id/complete`: checks the object, hashes it, and either marks the upload a
 * duplicate or puts `{ upload_id }` on the `ingest` queue. Answers JSON: `{ status }` on
 * success (`queued` or `duplicate`), `{ error }` otherwise, and a 429 with `Retry-After` when
 * the account's daily quota is spent.
 */
export async function completeUpload(c: CompleteContext) {
  const refuse = (status: 400 | 401 | 404 | 409 | 413 | 500 | 503, error: string) =>
    c.json({ error }, status, NO_STORE);

  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");

  const id = c.req.param("id");
  if (id.length > MAX_ID || id.includes("\0")) return refuse(404, "There is no such upload.");

  // One connection serves every query here.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // Another user's upload is answered as an unknown one, so ids can't be probed.
    const upload = await getUploadOf(db, id, user.id);
    if (upload === null) return refuse(404, "There is no such upload.");
    // Ingest, or an earlier confirm, has taken it: its outcome is at GET /uploads/:id.
    const taken = () =>
      refuse(409, "That upload was already handled. Check its status on the upload page.");
    if (upload.status !== "pending") return taken();

    // A spent quota is refused before the object is read or hashed, which costs the most. The
    // upload stays `pending` with its object, so it can be confirmed after the reset. The
    // atomic count below is what holds the cap; this read only saves work.
    const quota = await getUploadQuota(db, user.id);
    if (quota === null) return refuse(404, "There is no such upload.");
    const limit = limitFor(quota.role, c.env);
    if (quota.usedToday >= limit) return quotaSpent(c);

    const missing = () => refuse(400, "That file didn't finish uploading. Please upload it again.");
    // The declared size was checked at POST /uploads, but the PUT can store more. The row is
    // marked first, and only the request that marks it deletes the object. A delete that fails
    // leaves the object for the bucket's 7-day lifecycle rule.
    const discardOversized = async () => {
      if (!(await rejectOversizedUpload(db, upload.id))) return taken();
      try {
        await c.env.BUCKET.delete(upload.r2_key);
      } catch (error) {
        console.error("deleting an oversized object failed", error);
      }
      return refuse(
        413,
        `That file is over the ${MAX_UPLOAD_MB} MB limit, so it can't be uploaded.`,
      );
    };

    const head = await c.env.BUCKET.head(upload.r2_key);
    if (head === null) return missing();
    if (head.size > MAX_UPLOAD_BYTES) return discardOversized();

    // The presigned URL still works for ten minutes, so the object can have been replaced since
    // the HEAD: the size is checked again on the object that is hashed.
    const object = await c.env.BUCKET.get(upload.r2_key);
    if (object === null) return missing();
    if (object.size > MAX_UPLOAD_BYTES) {
      await object.body.cancel();
      return discardOversized();
    }
    // Streamed through the digest, never buffered: the body can be 25 MiB.
    const digest = new crypto.DigestStream("SHA-256");
    await object.body.pipeTo(digest);
    const sha256 = hex(await digest.digest);

    const recorded = await recordUploadHash(db, upload.id, sha256);
    // Taken by another request between the lookup and now.
    if (recorded === null) return taken();
    if (recorded.duplicateOf !== null) {
      // No second copy is kept. A failed delete leaves it for the 7-day lifecycle rule.
      try {
        await c.env.BUCKET.delete(upload.r2_key);
      } catch (error) {
        console.error("deleting a duplicate's object failed", error);
      }
      // No work id in the reply: the uploader's link is GET /uploads/:id's, which shows a work
      // only while it is live, and by its public id.
      return c.json({ status: "duplicate" }, 200, NO_STORE);
    }

    // The daily quota counts the uploads that reach the queue, and this is where its hard cap
    // holds: one conditional UPDATE, so parallel confirms can't pass it together. A duplicate
    // costs no ingest, so it was answered above without counting.
    if (!(await useUploadQuota(db, user.id, limit))) {
      // Only a confirm that lost a race for the last use gets here: the row is marked first,
      // and only the request that marks it deletes the object, as for an oversized one. A
      // delete that fails leaves it for the 7-day lifecycle rule.
      if (!(await rejectOverQuotaUpload(db, upload.id))) return taken();
      try {
        await c.env.BUCKET.delete(upload.r2_key);
      } catch (error) {
        console.error("deleting an over-quota object failed", error);
      }
      return quotaSpent(c);
    }

    // The hash is stored by now, so a failed send leaves a `pending` row that a retried
    // confirm takes through again. Its use of the quota is given back, or the retry would
    // count it twice.
    try {
      await c.env.INGEST.send({ upload_id: upload.id });
    } catch (error) {
      console.error("ingest queue send failed", error);
      try {
        await refundUploadQuota(db, user.id);
      } catch (refundError) {
        console.error(
          "refunding the quota failed",
          refundError instanceof Error ? refundError.name : "unknown",
        );
      }
      return refuse(503, "We couldn't queue that file just now. Please try again in a minute.");
    }
    return c.json({ status: "queued" }, 200, NO_STORE);
  } catch (error) {
    // The page's script reads JSON: a fault in the database or R2 gets one too.
    // Only the error's name: a driver's message can carry the query's values, the file's hash.
    console.error("confirming an upload failed", error instanceof Error ? error.name : "unknown");
    return refuse(500, "Something went wrong confirming that file. Please try again.");
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
