import { originalKey, versionOriginalFormat, type Database } from "@archive/db";
import { EpubError, LIMITS, type ParsedWork } from "@archive/epub";
import { sql, type Kysely } from "kysely";
import type { JobDeps } from "./job";
import { ListCheckRejected, onRejectList } from "./lists";
import type { BackfillMessage } from "./message";
import {
  clearRemovedWork,
  saveBackfill,
  SaveRejected,
  type SaveBucket,
  type WorkImages,
} from "./save";

/** What a backfill job needs: the request's Kysely, the bucket and the processor. */
export interface BackfillDeps {
  db: Kysely<Database>;
  bucket: SaveBucket;
  process: JobDeps["process"];
}

/**
 * Re-makes the work's current version from its stored original with the processor as it is
 * now (ARCHITECTURE, EPUB processor, step 8), while that version is still the one the message
 * names. Returns what became of it, for the log: `backfilled`, or why the current version was
 * left as it is (`no_work`, `removed`, `not_current`, `original_missing`, `too_large`,
 * `work_mismatch`, `opted_out`, `optout_check_rejected_<sqlstate>` (the opt-out table refused a value
 * in the file), or an `EpubError`'s or `SaveRejected`'s code: the processor's
 * verdict on the original as it now stands). Each is final, so the message is acked: a short
 * fixed code, never text from the file. Throws on a failure worth retrying, such as R2 or
 * Postgres being down.
 */
export async function runBackfill(deps: BackfillDeps, message: BackfillMessage): Promise<string> {
  const row = await deps.db
    .selectFrom("works")
    .innerJoin("work_versions", "work_versions.id", "works.current_version_id")
    .select([
      "works.ao3_work_id",
      "works.status",
      "works.current_version_id",
      "work_versions.upload_id",
      "work_versions.source_upload_id",
      "work_versions.review_reasons",
      versionOriginalFormat.as("original_format"),
      // Keeps Hyperdrive from answering from its cache: a stale pointer or status would re-make
      // a work already done, or miss a removal.
      sql<Date>`now()`.as("read_at"),
    ])
    .where("works.id", "=", message.work_id)
    .executeTakeFirst();
  // No such work, or one with no version yet: nothing to re-make.
  if (row === undefined) return "no_work";
  // Its fragments and originals are purged with it (#398). The folder is cleared again, for an
  // earlier attempt of this message that raced the removal and wrote after its purge.
  if (row.status === "removed") {
    await clearRemovedWork(deps.bucket, row.ao3_work_id);
    return "removed";
  }
  // Already backfilled (a redelivery after the commit lands here), or a moderator or a newer
  // upload has moved the work since the message was made.
  if (row.current_version_id !== message.version_id) return "not_current";
  // A backfill version names the upload it was re-made from; the schema gives every version one.
  const originalUploadId = row.upload_id ?? row.source_upload_id;
  if (originalUploadId === null) throw new Error("a version names no original");
  const object = await deps.bucket.get(originalKey(originalUploadId, row.original_format));
  if (object === null) return "original_missing";
  // As for an upload: by the object's size, before its body is read.
  if (object.size > LIMITS.maxInputBytes) {
    await object.body.cancel().catch(() => undefined);
    return "too_large";
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const images: WorkImages = new Map();
  let work: ParsedWork;
  try {
    work = await deps.process(bytes, images);
  } catch (error) {
    if (!(error instanceof EpubError)) throw error;
    // The file the current processor refuses stays as it was: its current version is kept.
    return error.code;
  }
  if (work.ao3WorkId !== String(row.ao3_work_id)) return "work_mismatch";
  // Before anything is written: what an opt-out now blocks is not published again.
  try {
    if (await onRejectList(deps.db, work)) return "opted_out";
  } catch (error) {
    // The file stays as it was, as for a processor refusal above.
    if (error instanceof ListCheckRejected) return error.code;
    throw error;
  }
  try {
    return await saveBackfill(
      deps,
      {
        workId: message.work_id,
        ao3WorkId: row.ao3_work_id,
        versionId: message.version_id,
        originalUploadId,
        reviewReasons: row.review_reasons,
      },
      work,
      images,
    );
  } catch (error) {
    if (error instanceof SaveRejected) return error.code;
    throw error;
  }
}
