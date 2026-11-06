import {
  createDb,
  type Database,
  deleteOpenUpload,
  endBannedUpload,
  getUploadOf,
  isBanned,
  isOpenRow,
  type OwnUpload,
} from "@archive/db";
import type { Context } from "hono";
import type { Kysely } from "kysely";
import type { Bindings } from "./env";
import { NO_STORE } from "./login";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { BANNED_UPLOADER } from "./upload";
import { EPUB_TYPE, isUploadId, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./upload-limit";

// ARCHITECTURE, Ingestion pipeline, step 2. The upload page's script sends each file to
// `PUT /uploads/:id`, and this Worker streams it to R2 through the bucket binding. Only an open
// upload takes a file, and only once, so nothing can be stored outside a live row. A file that
// fails frees its upload's slot at once.

type UploadIdContext = Context<
  {
    Bindings: Bindings;
    Variables: SecurityVariables & SessionVariables;
  },
  "/uploads/:id"
>;

/** The object is written only if the key holds none: R2 evaluates this as it commits the write. */
const CREATE_ONLY = new Headers({ "If-None-Match": "*" });

// What the upload routes say, here and in upload-complete.ts.
export const DIDNT_FINISH = "That file didn't finish uploading. Please upload it again.";
export const WRONG_SIZE =
  "That file isn't the size it was when you picked it, so it wasn't kept. Please upload it again.";
export const NO_SUCH_UPLOAD = "There is no such upload.";
export const ALREADY_HANDLED =
  "That upload was already handled. Check its status on the upload page.";

/**
 * Deletes an upload's object. One that fails is left for the bucket's 7-day lifecycle rule, and
 * nothing the uploader is told depends on it.
 */
export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch (error) {
    console.error(
      "deleting an upload's object failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
}

/**
 * Frees an upload that failed: its row, then its object. True when this request deleted the row.
 * False when it was no longer the user's open upload: its object is then someone else's to read
 * or remove, so a request acting on what it read earlier can't take a file from a confirm or
 * from ingest.
 */
export async function freeUpload(
  db: Kysely<Database>,
  bucket: R2Bucket,
  id: string,
  userId: string,
): Promise<boolean> {
  const key = await deleteOpenUpload(db, id, userId);
  if (key === null) return false;
  await deleteObject(bucket, key);
  return true;
}

/**
 * If the account is banned, ends the upload as a ban would, and its object goes too, by the request
 * that ended it. Read from the database, never the session: a ban holds at once (ARCHITECTURE,
 * Moderation).
 */
export async function endIfBanned(
  db: Kysely<Database>,
  bucket: R2Bucket,
  upload: OwnUpload,
  userId: string,
): Promise<boolean> {
  if (!(await isBanned(db, userId))) return false;
  if (await endBannedUpload(db, upload.id, userId)) await deleteObject(bucket, upload.r2_key);
  return true;
}

/** Why this request's headers can't carry this upload's file, or null when they can. */
function headerRefusal(request: Request, bytes: number) {
  if (request.headers.get("content-type") !== EPUB_TYPE) {
    return { status: 415, error: "Only epub files can be uploaded." } as const;
  }
  const length = request.headers.get("content-length");
  if (request.body === null || length === null || !/^[0-9]+$/.test(length)) {
    return { status: 411, error: DIDNT_FINISH } as const;
  }
  if (Number(length) > MAX_UPLOAD_BYTES) {
    return {
      status: 413,
      error: `That file is over the ${MAX_UPLOAD_MB} MB limit, so it can't be uploaded.`,
    } as const;
  }
  if (Number(length) !== bytes) {
    return { status: 400, error: WRONG_SIZE } as const;
  }
  return null;
}

/**
 * Streams the body to R2 and settles what the upload's row says now. Never buffered: a body can
 * be 25 MiB and an isolate's memory is shared. A FixedLengthStream of the size declared, which
 * the limit bounds, errors on the first byte too many or on an end too soon, and `put` then fails
 * with nothing stored, whatever the request's headers said.
 */
async function store(
  c: UploadIdContext,
  upload: OwnUpload,
  userId: string,
  body: ReadableStream,
): Promise<"stored" | "ended" | "failed"> {
  const bucket = c.env.BUCKET;
  let written = true;
  try {
    const object = await bucket.put(
      upload.r2_key,
      body.pipeThrough(new FixedLengthStream(upload.bytes)),
      { onlyIf: CREATE_ONLY, httpMetadata: { contentType: EPUB_TYPE } },
    );
    // A file is there already, and it stays.
    if (object === null) return "ended";
  } catch (error) {
    console.error("storing an upload failed", error instanceof Error ? error.name : "unknown");
    written = false;
  }
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    if (!written) {
      await freeUpload(db, bucket, upload.id, userId);
      return "failed";
    }
    // The row was checked before the bytes arrived, and a ban, the reaper or a confirm finding
    // no file can have ended it since. Then the object has no row to answer for it, and nothing
    // reads it. A `pending` or `processing` row is different: if a confirm has counted it, this
    // object is ingest's.
    const now = await getUploadOf(db, upload.id, userId);
    if (now === null || (now.status !== "pending" && now.status !== "processing")) {
      await deleteObject(bucket, upload.r2_key);
      return "ended";
    }
    return "stored";
  } catch (error) {
    // The reaper has a row left open. A stored file is left for the confirm, which reads the row.
    console.error("settling an upload failed", error instanceof Error ? error.name : "unknown");
    return written ? "stored" : "failed";
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}

/**
 * `PUT /uploads/:id`: stores the file of the user's open upload. Answers JSON: `{ status: "stored" }`
 * or `{ error }`. The object is checked and hashed later, at `POST /uploads/:id/complete`.
 */
export async function putUpload(c: UploadIdContext) {
  const refuse = (status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 500, error: string) =>
    c.json({ error }, status, NO_STORE);

  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");
  const id = c.req.param("id");
  if (!isUploadId(id)) return refuse(404, NO_SUCH_UPLOAD);

  // One connection for the checks, closed before the body is read: a slow upload holds no
  // connection, and no lock a ban would wait on.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  let upload: OwnUpload | null;
  try {
    // Another user's upload is answered as an unknown one, so ids can't be probed.
    upload = await getUploadOf(db, id, user.id);
    if (upload === null) return refuse(404, NO_SUCH_UPLOAD);
    if (!isOpenRow(upload)) return refuse(409, ALREADY_HANDLED);
    if (await endIfBanned(db, c.env.BUCKET, upload, user.id)) {
      return refuse(403, BANNED_UPLOADER);
    }
    // Its one file is here: a repeat costs a lookup, not a body, and this file stays. The write
    // below still decides, for two sends at once.
    if ((await c.env.BUCKET.head(upload.r2_key)) !== null) return refuse(409, ALREADY_HANDLED);
    const refusal = headerRefusal(c.req.raw, upload.bytes);
    if (refusal !== null) {
      await freeUpload(db, c.env.BUCKET, upload.id, user.id);
      return refuse(refusal.status, refusal.error);
    }
  } catch (error) {
    // The page's script reads JSON: a fault in the database gets one too.
    console.error("checking an upload failed", error instanceof Error ? error.name : "unknown");
    return refuse(500, "Something went wrong sending that file. Please try again.");
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }

  // SAFETY: headerRefusal refuses a request with no body.
  const body = c.req.raw.body as ReadableStream;
  // Kept alive past a client that goes away, whose failed read is what starts the clean-up.
  const stored = store(c, upload, user.id, body);
  c.executionCtx.waitUntil(stored);
  const outcome = await stored;
  if (outcome === "ended") return refuse(409, ALREADY_HANDLED);
  if (outcome === "failed") return refuse(400, DIDNT_FINISH);
  return c.json({ status: "stored" }, 200, NO_STORE);
}

/**
 * `DELETE /uploads/:id`: the page reporting that an upload failed, so its slot is free for the
 * next try. It only ever frees the user's own open upload: anything else is an unknown upload.
 * A closed tab reports nothing, and the reaper has those.
 */
export async function giveUpUpload(c: UploadIdContext) {
  const refuse = (status: 401 | 404 | 500, error: string) => c.json({ error }, status, NO_STORE);

  const user = c.var.session?.user;
  if (user === undefined) return refuse(401, "Sign in to upload.");
  const id = c.req.param("id");
  if (!isUploadId(id)) return refuse(404, NO_SUCH_UPLOAD);

  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    if (!(await freeUpload(db, c.env.BUCKET, id, user.id))) return refuse(404, NO_SUCH_UPLOAD);
    return c.json({ status: "freed" }, 200, NO_STORE);
  } catch (error) {
    console.error("freeing an upload failed", error instanceof Error ? error.name : "unknown");
    return refuse(500, "Something went wrong. Please try again.");
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
