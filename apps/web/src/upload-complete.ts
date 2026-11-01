import { createDb, getUploadOf, recordUploadHash, rejectOversizedUpload } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
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

const NO_STORE = { "Cache-Control": "no-store" };

/** The lowercase hex of a SHA-256 digest. */
const hex = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `POST /uploads/:id/complete`: checks the object, hashes it, and either marks the upload a
 * duplicate or puts `{ upload_id }` on the `ingest` queue. Answers JSON: `{ status }` on
 * success (`queued`, or `duplicate` with the work's id), `{ error }` otherwise.
 */
export async function completeUpload(c: CompleteContext) {
  const refuse = (status: 400 | 401 | 404 | 409 | 413 | 503, error: string) =>
    c.json({ error }, status, NO_STORE);

  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");
  // U4: the daily upload quota count goes here, after the session.

  // One connection serves every query here.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // Another user's upload is answered as an unknown one, so ids can't be probed.
    const upload = await getUploadOf(db, c.req.param("id"), user.id);
    if (upload === null) return refuse(404, "There is no such upload.");
    // Ingest, or an earlier confirm's duplicate mark, has taken it.
    if (upload.status !== "pending") return refuse(409, "That upload was already confirmed.");

    const head = await c.env.BUCKET.head(upload.r2_key);
    if (head === null) {
      return refuse(400, "That file didn't finish uploading. Please upload it again.");
    }
    const tooLarge = () =>
      refuse(413, `That file is over the ${MAX_UPLOAD_MB} MB limit, so it can't be uploaded.`);
    // The declared size was checked at POST /uploads, but the PUT can store more.
    if (head.size > MAX_UPLOAD_BYTES) {
      await rejectOversizedUpload(db, upload.id);
      await c.env.BUCKET.delete(upload.r2_key);
      return tooLarge();
    }

    // The presigned URL still works for ten minutes, so the object can have been replaced since
    // the HEAD: the size is checked again on the object that is hashed.
    const object = await c.env.BUCKET.get(upload.r2_key);
    if (object === null) {
      return refuse(400, "That file didn't finish uploading. Please upload it again.");
    }
    if (object.size > MAX_UPLOAD_BYTES) {
      await object.body.cancel();
      await rejectOversizedUpload(db, upload.id);
      await c.env.BUCKET.delete(upload.r2_key);
      return tooLarge();
    }
    // Streamed through the digest, never buffered: the body can be 25 MiB.
    const digest = new crypto.DigestStream("SHA-256");
    await object.body.pipeTo(digest);
    const sha256 = hex(await digest.digest);

    const recorded = await recordUploadHash(db, upload.id, sha256);
    // Taken by another request between the lookup and now.
    if (recorded === null) return refuse(409, "That upload was already confirmed.");
    if (recorded.duplicateOf !== null) {
      // No second copy is kept. A failed delete leaves it for the bucket's 7-day lifecycle rule.
      try {
        await c.env.BUCKET.delete(upload.r2_key);
      } catch (error) {
        console.error("deleting a duplicate's object failed", error);
      }
      return c.json({ status: "duplicate", work_id: recorded.duplicateOf }, 200, NO_STORE);
    }

    // The hash is stored by now, so a failed send leaves a `pending` row that a retried
    // confirm takes through again.
    try {
      await c.env.INGEST.send({ upload_id: upload.id });
    } catch (error) {
      console.error("ingest queue send failed", error);
      return refuse(503, "We couldn't queue that file just now. Please try again in a minute.");
    }
    return c.json({ status: "queued" }, 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
