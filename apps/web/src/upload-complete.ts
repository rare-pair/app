import {
  createDb,
  getUploadOf,
  getUploadQuota,
  recordUploadHash,
  countUploadQuota,
  refundUploadQuota,
  rejectOverQuotaUpload,
} from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { NO_STORE } from "./login";
import { limitFor, quotaSpent } from "./quota";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { BANNED_UPLOADER } from "./upload";
import { isUploadId } from "./upload-limit";
import {
  ALREADY_HANDLED,
  deleteObject,
  DIDNT_FINISH,
  endIfBanned,
  freeUpload,
  NO_SUCH_UPLOAD,
  WRONG_SIZE,
} from "./upload-put";

// ARCHITECTURE, Ingestion pipeline, step 3. The upload page's script calls
// `POST /uploads/:id/complete` once its `PUT /uploads/:id` has finished. A confirm that fails
// frees the upload's slot at once: its row and its object go.

type CompleteContext = Context<
  {
    Bindings: Bindings;
    Variables: SecurityVariables & SessionVariables;
  },
  "/uploads/:id/complete"
>;

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
  const refuse = (status: 400 | 401 | 403 | 404 | 409 | 500 | 503, error: string) =>
    c.json({ error }, status, NO_STORE);

  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");

  const id = c.req.param("id");
  if (!isUploadId(id)) return refuse(404, NO_SUCH_UPLOAD);

  // One connection serves every query here.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // Another user's upload is answered as an unknown one, so ids can't be probed.
    const upload = await getUploadOf(db, id, user.id);
    if (upload === null) return refuse(404, NO_SUCH_UPLOAD);
    // Ingest, or an earlier confirm, has taken it: its outcome is at GET /uploads/:id.
    const taken = () => refuse(409, ALREADY_HANDLED);
    // A ban ended it, and nothing will read its file now.
    if (upload.status === "account_banned") await deleteObject(c.env.BUCKET, upload.r2_key);
    if (upload.status !== "pending") return taken();
    // A ban ends an account's pending uploads; this one was written after it, so it is ended
    // the same way. Before the object is read, so nothing of it is hashed or queued.
    if (await endIfBanned(db, c.env.BUCKET, upload, user.id)) {
      return refuse(403, BANNED_UPLOADER);
    }

    // An upload over the quota is marked first, and only the request that marks it deletes the
    // object. The mark is refused for an upload another confirm has counted, so a loser never
    // rejects or deletes what a parallel confirm of the same upload won.
    const discardOverQuota = async () => {
      if (!(await rejectOverQuotaUpload(db, upload.id, user.id))) return null;
      await deleteObject(c.env.BUCKET, upload.r2_key);
      return quotaSpent(c);
    };

    // A spent quota is refused before the object is read or hashed, which costs the most. The
    // atomic count below is what holds the cap; this read only saves work. An upload that is
    // already counted goes on instead: its confirm is a repeat.
    const quota = await getUploadQuota(db, user.id);
    if (quota === null) return refuse(404, NO_SUCH_UPLOAD);
    const limit = limitFor(quota.role, c.env);
    if (quota.usedToday >= limit) {
      const refused = await discardOverQuota();
      if (refused !== null) return refused;
    }

    // Frees the upload and says why. One a confirm has counted isn't freed: it is in the queue,
    // its confirm is a repeat, and its object is ingest's to read and to refuse.
    const fail = async (error: string) =>
      (await freeUpload(db, c.env.BUCKET, upload.id, user.id)) ? refuse(400, error) : taken();

    const object = await c.env.BUCKET.get(upload.r2_key);
    if (object === null) return await fail(DIDNT_FINISH);
    // PUT /uploads/:id stores nothing else, so this holds unless R2 has broken its promises to
    // that route: the check that matters is on the object about to be hashed.
    if (object.size !== upload.bytes) {
      await object.body.cancel();
      return await fail(WRONG_SIZE);
    }
    // Streamed through the digest, never buffered: the body can be 25 MiB.
    const digest = new crypto.DigestStream("SHA-256");
    await object.body.pipeTo(digest);
    const sha256 = hex(await digest.digest);

    const recorded = await recordUploadHash(db, upload.id, sha256);
    // Taken by another request between the lookup and now.
    if (recorded === null) return taken();
    if (recorded.duplicateOf !== null) {
      // No second copy is kept.
      await deleteObject(c.env.BUCKET, upload.r2_key);
      // No work id in the reply: the uploader's link is GET /uploads/:id's, which shows a work
      // only while it is live, and by its public id.
      return c.json({ status: "duplicate" }, 200, NO_STORE);
    }

    // The daily quota counts the uploads that reach the queue, and this is where its hard cap
    // holds: one conditional UPDATE, so parallel confirms can't pass it together. A duplicate
    // costs no ingest, so it was answered above without counting.
    // An upload is counted once: a repeat confirm of one that is counted is `already`, and is
    // queued again (ingest's lease makes a second job a no-op) without taking another use.
    const counted = await countUploadQuota(db, user.id, upload.id, limit);
    // Another request ended it (an over-quota upload, or a failed confirm) since the lookup.
    if (counted === "gone") return taken();
    if (counted === "spent") {
      // Lost a race for the last use.
      return (await discardOverQuota()) ?? taken();
    }

    // The page never sends the same confirm again, so a failed send frees the slot for the next
    // click: the use is given back, then the open row and its object go. Only by the request
    // that counted it: a repeat's failed send says nothing of the first's message, which the
    // row and object must be there for.
    try {
      await c.env.INGEST.send({ upload_id: upload.id });
    } catch (error) {
      console.error("ingest queue send failed", error);
      if (counted === "counted") {
        try {
          await refundUploadQuota(db, user.id, upload.id);
          await freeUpload(db, c.env.BUCKET, upload.id, user.id);
        } catch (refundError) {
          console.error(
            "refunding the quota failed",
            refundError instanceof Error ? refundError.name : "unknown",
          );
        }
      }
      return refuse(
        503,
        "We couldn't queue that file just now. Please upload it again in a minute.",
      );
    }
    return c.json({ status: "queued" }, 200, NO_STORE);
  } catch (error) {
    // The page's script reads JSON: a fault in the database or R2 gets one too.
    // Only the error's name: a driver's message can carry the query's values, the file's hash.
    console.error("confirming an upload failed", error instanceof Error ? error.name : "unknown");
    // Only an upload still open: one a confirm has counted is in the queue.
    try {
      await freeUpload(db, c.env.BUCKET, id, user.id);
    } catch (freeError) {
      // The reaper removes the row, and the object with it.
      console.error(
        "freeing a failed confirm failed",
        freeError instanceof Error ? freeError.name : "unknown",
      );
    }
    return refuse(500, "Something went wrong confirming that file. Please upload it again.");
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
