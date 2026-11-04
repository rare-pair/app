import { isUploaderBanned, type Database } from "@archive/db";
import { EpubError, LIMITS, type ParsedWork } from "@archive/epub";
import type { Kysely } from "kysely";
import { MAX_RETRIES } from "./config";
import {
  claimLease,
  endLease,
  LEASE_TIMING,
  LeaseKeeper,
  LeaseLost,
  type Lease,
  type LeaseTiming,
  type Outcome,
  type Stage,
} from "./lease";
import { ListCheckRejected, onRejectList } from "./lists";
import { AccountBanned, deleteOriginal, SaveRejected, WorkRemoved, type WorkImages } from "./save";

/** What a job needs from outside: the request's Kysely, the bucket and the two steps. */
export interface JobDeps {
  db: Kysely<Database>;
  bucket: Pick<R2Bucket, "get" | "list" | "delete">;
  /**
   * The epub processor: bytes in, a parsed work out, or an `EpubError`. It adds each image the
   * work shows to `images`, if given.
   */
  process: (bytes: Uint8Array, images?: WorkImages) => Promise<ParsedWork>;
  /**
   * Saves the parsed work from the upload's `bytes` (R2 fragments, `originals/`, the Postgres
   * transaction). Throws `SaveRejected` for a file that can't be saved, `WorkRemoved` for an
   * upload of a removed work, `AccountBanned` for an upload by a banned account, and
   * `LeaseLost` when another job has taken the upload over.
   */
  save: (upload: Lease, work: ParsedWork, bytes: Uint8Array, images?: WorkImages) => Promise<void>;
  /** The lease's length and renewal interval, when not the production ones. */
  timing?: LeaseTiming;
}

/** What the queue does with the message: `ack` it, or `retry` it. */
export type Verdict = "ack" | "retry";

/**
 * Runs one upload's job, on the message's `attempt` (from 1), and says whether its message is
 * done. A rejection is final and recorded at once. Any other failure, such as R2 or Postgres
 * being down, is retried with the lease released; on the last attempt it is recorded as
 * `parse_failed` and retried, so the queue dead-letters it.
 */
export async function runJob(deps: JobDeps, uploadId: string, attempt: number): Promise<Verdict> {
  const timing = deps.timing ?? LEASE_TIMING;
  const lease = await claimLease(deps.db, uploadId, timing.seconds);
  // Another job holds it, or it is done: this delivery has nothing to do.
  if (lease === null) return "ack";
  // Renewed for as long as the job runs, so a long one is not taken for dead (#215).
  const keeper = new LeaseKeeper(deps.db, lease, timing);
  lease.keeper = keeper;
  keeper.start();
  let stage: Stage = "read";
  let outcome: Outcome | null;
  try {
    outcome = await run(deps, lease, (next) => (stage = next));
  } catch (error) {
    // Waited for, so no renewal changes the token under the ending write below.
    await keeper.stop();
    // The job that took the upload over records the outcome: this one writes nothing.
    if (error instanceof LeaseLost) {
      console.warn({ event: "ingest.lease_lost", uploadId, stage });
      return "ack";
    }
    const final = attempt > MAX_RETRIES;
    const ending: Outcome = final
      ? { status: "parse_failed", failure: { stage, error: errorCode(error) } }
      : { status: "pending" };
    await discardOriginalAfter(deps, lease, ending, await endLease(deps.db, lease, ending));
    return "retry";
  }
  await keeper.stop();
  // Outside the job's try: if this write fails, it is not recorded as the job's own failure.
  // The message is retried and the rejection found again, unless this was the last attempt
  // (#214).
  if (outcome !== null) {
    await discardOriginalAfter(deps, lease, outcome, await endLease(deps.db, lease, outcome));
  }
  return "ack";
}

/**
 * Deletes the refused upload's `originals/` file (#576), after the ending write that made the
 * refusal final, and only if that write matched. The order is the safety: a matched write means
 * no job took the upload over, and a final status can't be claimed again, so no other job can
 * write this key after the check. A delete before the ending write leaves a window where a
 * takeover stores the file and this job removes it from under a version that goes live. A crash
 * between the two leaves the file. A retry (`pending`) keeps it, and so does `work_removed`,
 * which the save already cleaned up. A failed delete is logged and changes nothing: the upload
 * is final and its message is not retried for it.
 */
async function discardOriginalAfter(
  deps: JobDeps,
  lease: Lease,
  outcome: Outcome,
  ended: boolean,
): Promise<void> {
  if (!ended || outcome.status === "pending" || outcome.status === "work_removed") return;
  try {
    const deleted = await deleteOriginal(deps.bucket, lease.id);
    console.log({ event: "ingest.refused_original_deleted", uploadId: lease.id, deleted });
  } catch (error) {
    console.error({
      event: "ingest.refused_original_delete_failed",
      uploadId: lease.id,
      error: errorCode(error),
    });
  }
}

/** A banned account's upload, refused at `stage`: no retry lifts a ban (there is no unban). */
const ACCOUNT_BANNED = (stage: Stage): Outcome => ({
  status: "account_banned",
  failure: { stage, error: "account_banned" },
});

/**
 * Reads, processes and saves the upload. Returns the outcome to record, or null when the work
 * was saved; throws on a failure worth retrying.
 */
async function run(
  deps: JobDeps,
  lease: Lease,
  enter: (stage: Stage) => void,
): Promise<Outcome | null> {
  // A ban stops the account's in-flight uploads (ARCHITECTURE, Moderation): before the file is
  // read. The save checks again in its transaction, for a ban that lands while the job runs.
  if (await isUploaderBanned(deps.db, lease.id)) return ACCOUNT_BANNED("read");
  const object = await deps.bucket.get(lease.r2Key);
  // Gone, as after the 7-day expiry of uploads/ (#176): no retry brings it back.
  if (object === null) {
    return { status: "parse_failed", failure: { stage: "read", error: "object_missing" } };
  }
  // By the object's size, before its body is read: an over-limit file never reaches memory.
  if (object.size > LIMITS.maxInputBytes) {
    // Only to free the stream: a failure to cancel it doesn't change the verdict.
    await object.body.cancel().catch(() => undefined);
    return { status: "too_large", failure: { stage: "read", error: "too_large" } };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  // Still the job's before the slow step? Throws `LeaseLost` if another job took it over.
  await lease.keeper?.renew();
  enter("process");
  let work: ParsedWork;
  const images: WorkImages = new Map();
  try {
    work = await deps.process(bytes, images);
  } catch (error) {
    if (!(error instanceof EpubError)) throw error;
    // The same bytes are rejected the same way every time, `parse_failed` included.
    return { status: error.code, failure: { stage: "process", error: error.code } };
  }
  // Before anything is written. A failure to read the lists throws, still in `process`.
  let rejected: boolean;
  try {
    rejected = await onRejectList(deps.db, work);
  } catch (error) {
    // A value in the file the lists refuse (a NUL byte in a pseud): the same on every attempt.
    if (!(error instanceof ListCheckRejected)) throw error;
    return { status: "parse_failed", failure: { stage: "process", error: error.code } };
  }
  if (rejected) {
    return { status: "opted_out", failure: { stage: "process", error: "opted_out" } };
  }
  await lease.keeper?.renew();
  enter("save");
  try {
    // A saved upload has its final status already (`live`, `held_for_review` or `duplicate`):
    // the save sets it in the work's transaction.
    await deps.save(lease, work, bytes, images);
  } catch (error) {
    // A removed work stays so until a moderator restores it: no retry changes the verdict.
    if (error instanceof WorkRemoved) {
      return { status: "work_removed", failure: { stage: "save", error: "work_removed" } };
    }
    if (error instanceof AccountBanned) return ACCOUNT_BANNED("save");
    if (!(error instanceof SaveRejected)) throw error;
    return { status: "parse_failed", failure: { stage: "save", error: error.code } };
  }
  return null;
}

/**
 * A short code for a failure, for `uploads.error` (which an uploader's page may show) and the
 * logs: the error's class, never its message, which can quote anything. The constructor's
 * name, since pg's `DatabaseError` sets `name` to "error".
 */
// oxlint-disable-next-line deslop/no-unknown-parameters -- a caught value is unknown by contract
export function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
}
