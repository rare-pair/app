import {
  copyVersionToWork,
  isUploaderBanned,
  ORIGINAL_MEDIA_TYPES,
  originalKey,
  originalKeys,
  type Database,
  type HoldReason,
  type TagType,
  type UploadStatus,
} from "@archive/db";
import type { ParsedWork } from "@archive/epub";
import { sql, type Kysely, type Transaction } from "kysely";
import { LeaseLost, type Lease } from "./lease";
import { isDataErrorState, sqlState } from "./sql-state";
import { MAX_INT4, parseWorkId } from "./work-id";
import { decideVersion, sameSet, type VersionDecision, type VersionFacts } from "./versioning";

/**
 * What saving needs from the bucket: writes, reads of the current version's fragments, and the
 * listing and deletes that clear a removed work's folder again.
 */
export interface SaveBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | Uint8Array, options?: R2PutOptions): Promise<R2Object | null>;
  list(options: R2ListOptions): Promise<R2Objects>;
  delete(keys: string[]): Promise<void>;
}

/** R2's most keys for one list page and for one delete call. */
const R2_BATCH = 1000;

/**
 * Deletes everything under a removed work's `works/<ao3_work_id>/` folder, as its removal did
 * (apps/web, remove-objects.ts): what a backfill that raced the removal put back. Every key is
 * listed before any is deleted. Deleting a key already gone is no error, so a repeat is safe.
 */
export const clearRemovedWork = (bucket: SaveBucket, ao3WorkId: number): Promise<number> =>
  clearPrefix(bucket, `works/${ao3WorkId}/`);

/** Deletes every key under `prefix`, and returns how many there were. */
async function clearPrefix(bucket: SaveBucket, prefix: string): Promise<number> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: R2_BATCH });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  for (let i = 0; i < keys.length; i += R2_BATCH) {
    await bucket.delete(keys.slice(i, i + R2_BATCH));
  }
  return keys.length;
}

/**
 * Deletes the raw file of upload `uploadId` and returns how many keys it found. Deleting a key
 * already gone is no error, so a repeat is safe. The caller must still own the upload: after a
 * takeover this key is the new job's.
 */
export async function deleteOriginal(
  bucket: Pick<SaveBucket, "list" | "delete">,
  uploadId: string,
): Promise<number> {
  const found = await bucket.list({ prefix: `originals/${uploadId}.`, limit: 2 });
  await bucket.delete(originalKeys(uploadId));
  return found.objects.length;
}

/**
 * Deletes the upload's staging file at `r2Key` and returns 1, or 0 for a key it won't touch. The
 * job has just read the file, so there is no listing to find it. A stored key is trusted only under
 * `uploads/`, so a bad row can't reach another work's objects. The caller must have ended the
 * upload: until then a later attempt reads this file.
 */
export async function deleteStagingFile(
  bucket: Pick<SaveBucket, "delete">,
  r2Key: string,
): Promise<number> {
  if (!r2Key.startsWith("uploads/")) return 0;
  await bucket.delete([r2Key]);
  return 1;
}

/**
 * Whether the work is removed now. `now()` keeps Hyperdrive from answering from its cache: a
 * stale `live` would leave behind what a job put back after a removal, and a stale `removed`
 * would delete a restored work's files.
 */
async function isRemovedNow(db: Kysely<Database>, ao3WorkId: number): Promise<boolean> {
  const row = await db
    .selectFrom("works")
    .select(["status", sql<Date>`now()`.as("read_at")])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  return row !== undefined && row.status === "removed";
}

/**
 * Deletes what an upload that lost to a removal wrote, since the removal's purge may have run
 * before the writes: its `originals/` file (the purge never finds it: the upload has no
 * `work_id`), and the work's `works/` folder, or only the upload's own prefix in it if the work
 * was restored meanwhile. Deleting
 * a key already gone is no error, so a repeat is safe. Only for `WorkRemoved`: a job that lost
 * its lease shares these keys with the job that took over.
 */
async function discardUploadFiles(
  deps: { db: Kysely<Database>; bucket: SaveBucket },
  lease: Lease,
  ao3WorkId: number,
): Promise<void> {
  let deleted = await deleteOriginal(deps.bucket, lease.id);
  // A work restored meanwhile keeps its folder, but not this upload's own fragments, which no
  // version row points at.
  deleted += (await isRemovedNow(deps.db, ao3WorkId))
    ? await clearRemovedWork(deps.bucket, ao3WorkId)
    : await clearPrefix(deps.bucket, `works/${ao3WorkId}/${lease.id}/`);
  console.log({ event: "ingest.lost_to_removal", uploadId: lease.id, deleted });
}

/**
 * The images a work's files show, by their SHA-256 key: collected while the epub is processed
 * and written by the save, so nothing reaches R2 before the opt-out check.
 */
export type WorkImages = Map<string, { mediaType: string; bytes: Uint8Array }>;

/**
 * A save that fails the same way on every attempt, because of the file itself: recorded at
 * once as `parse_failed` at the save stage, with `code` (short and fixed, never text from the
 * file) as its error.
 */
export class SaveRejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * The work the upload is of has been removed: nothing is saved, and the job ends the upload as
 * `work_removed`, at once, since removal is permanent: a removed work can't be restored, and a
 * successful counter-notice means uploading it again.
 */
export class WorkRemoved extends Error {}

/**
 * The upload's account was banned while the job ran: nothing is saved, and the job ends the
 * upload as `account_banned`, at once, since a ban is never lifted.
 */
export class AccountBanned extends Error {}

/**
 * The work changed between this job's read of it and its write: another job's save committed
 * first. The transaction rolls back, and the save reads the work again and decides again.
 */
class Stale extends Error {}

/** R2 writes in flight at once: a Worker limits its simultaneous subrequests. */
const PUT_POOL = 6;
/** Rows per INSERT, so a long work stays far under Postgres's 65,535 bind parameters. */
const ROWS_PER_INSERT = 1_000;
/** Times the save decides, when other jobs keep changing the work under it, before it fails. */
const MAX_ATTEMPTS = 3;

/** The work as already saved: the facts its current version is decided against. */
interface Current {
  workId: string;
  /** The pointer the facts were read under: a write checks it still holds. */
  versionId: string;
  facts: VersionFacts;
}

type Chapters = (ParsedWork["chapters"][number] & { key: string })[];

/**
 * Saves an upload, in the order ingest promises (ARCHITECTURE, EPUB processor, steps 7 and 8):
 * the chapter fragments under the upload's own prefix, the images under the work's shared
 * `img/` prefix (keyed by their bytes, left for the periodic sweep when no version references
 * them), then the raw file to `originals/`, then one Postgres transaction. A first upload of a
 * work creates it and sets it `live` last. A later one is decided by `decideVersion` against
 * the current version: a replace stores the version and moves `current_version_id` (the upload
 * is `live`); a hold stores the version without moving it (`held_for_review`); a duplicate
 * stores no version (`duplicate`). Every outcome writes the files; a duplicate's fragments,
 * which no version points at, are left for the periodic sweep (apps/sweep). A failure before or
 * inside the transaction leaves no rows, only R2 objects: under keys a retry overwrites when it
 * is worth one, and left for the sweep when the file is refused, except the
 * `originals/` file, which `runJob` deletes once the refusal is recorded (`deleteOriginal`); a
 * crash before that delete leaves it, and nothing removes it yet (rare-pair/app#592). A
 * save refused as `WorkRemoved` deletes the files it wrote (`discardUploadFiles`), never on
 * `LeaseLost`.
 */
export async function saveWork(
  deps: { db: Kysely<Database>; bucket: SaveBucket },
  lease: Lease,
  work: ParsedWork,
  bytes: Uint8Array,
  images: WorkImages = new Map(),
): Promise<void> {
  const ao3WorkId = workIdOf(work);
  if (work.chapters.length === 0) throw new SaveRejected("no_chapters");
  try {
    await saveFiles(deps, lease, work, bytes, images, ao3WorkId);
  } catch (error) {
    // The work was removed meanwhile, or earlier: what this job wrote, or what a failed clean-up
    // of an earlier attempt left, goes (ARCHITECTURE, EPUB processor, step 8).
    if (error instanceof WorkRemoved) {
      // Only while the upload is still this job's: after a takeover these files are the new
      // job's, and `LeaseLost` replaces the error (#526).
      await lease.keeper?.renew();
      await discardUploadFiles(deps, lease, ao3WorkId);
    }
    throw error;
  }
}

/** `saveWork` without the clean-up: the reads, the writes and the transaction. */
async function saveFiles(
  deps: { db: Kysely<Database>; bucket: SaveBucket },
  lease: Lease,
  work: ParsedWork,
  bytes: Uint8Array,
  images: WorkImages,
  ao3WorkId: number,
): Promise<void> {
  // Read before the writes below and never inside the transaction: the current version's text
  // comes from R2, which is slow, and a row lock must not be held across it.
  let current = await readCurrent(deps, ao3WorkId);
  const facts = factsOf(work, lease.format === "pdf");
  const prefix = `works/${ao3WorkId}/${lease.id}/`;
  // Before each write, the job checks it still holds the upload. A check leaves a window of one
  // write in flight, so the fence in the transaction has the last word.
  const held = () => lease.keeper?.check() ?? Promise.resolve();
  const chapters = await putFiles(deps.bucket, ao3WorkId, prefix, work, images, held);
  await held();
  const format = lease.format ?? "epub";
  await deps.bucket.put(originalKey(lease.id, format), bytes, {
    httpMetadata: { contentType: ORIGINAL_MEDIA_TYPES[format] },
  });
  // Stop renewing before the transaction: a renewal would change the token under its fence.
  await lease.keeper?.stop();
  for (let attempt = 1; ; attempt++) {
    // By hand, since the timer is off: the lease is whole for the transaction, and again after
    // each retry's slow reads.
    await lease.keeper?.renew();
    try {
      const decision = current === null ? null : decideVersion(current.facts, facts);
      await deps.db
        .transaction()
        .execute((trx) =>
          writeRows(trx, lease, work, ao3WorkId, prefix, chapters, current, decision),
        );
      return;
    } catch (error) {
      // The save's own refusals and a lost lease pass through as they are.
      if (
        error instanceof SaveRejected ||
        error instanceof LeaseLost ||
        error instanceof WorkRemoved ||
        error instanceof AccountBanned
      ) {
        throw error;
      }
      if (error instanceof Stale) {
        // Read the work as the other job left it and decide again: a second upload of the same
        // newer version, say, is now a duplicate. Out of attempts, it is a failure worth a retry.
        // Read first, so a removal that caused the `Stale` is refused even on the last attempt.
        current = await readCurrent(deps, ao3WorkId);
        if (attempt >= MAX_ATTEMPTS) throw new Error("the work kept changing under the save");
        continue;
      }
      throwSaveError(error);
    }
  }
}

/**
 * Writes a version's chapter fragments under `prefix`, then the work's images under its shared
 * `img/` prefix, keyed by their bytes, so a retry and every version of the work write the same
 * image keys. Returns the chapters with their keys.
 */
async function putFiles(
  bucket: SaveBucket,
  ao3WorkId: number,
  prefix: string,
  work: ParsedWork,
  images: WorkImages,
  beforePut: () => Promise<void> = async () => {},
): Promise<Chapters> {
  const chapters = work.chapters.map((c) => ({ ...c, key: `${prefix}${c.n}.html` }));
  await inPool(chapters, async (c) => {
    await beforePut();
    await bucket.put(c.key, c.html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  });
  await inPool([...images], async ([key, image]) => {
    await beforePut();
    await bucket.put(`works/${ao3WorkId}/img/${key}`, image.bytes, {
      httpMetadata: { contentType: image.mediaType },
    });
  });
  return chapters;
}

/** The version a backfill re-makes: the work's current one when the message was made. */
export interface BackfillSource {
  workId: string;
  ao3WorkId: number;
  versionId: string;
  /** The upload whose `originals/<id>.epub` the version was made from. */
  originalUploadId: string;
  reviewReasons: string[];
}

/**
 * Saves a backfill: a new version of the work re-made from the source version's original by
 * the processor as it is now (ARCHITECTURE, EPUB processor, step 8). It is decided by neither
 * `decideVersion` nor any upload: the same file, re-sanitized, always replaces its source. Its
 * fragments go under a prefix of its own, `works/<ao3_work_id>/<version id>/`, so no fragment
 * already written is rewritten and every cached one keeps its key; its images go to the
 * work's `img/` prefix; the original is not written again. Then one transaction adds the
 * version and moves `current_version_id` to it only if it is still the source version
 * (compare-and-swap), and makes the work describe it, its summary included even when it has
 * none. Status is left as it is. Returns `backfilled`; `not_current` when the pointer had
 * moved, and nothing was committed (the new prefix's fragments are then left for the periodic
 * sweep, as are a failed attempt's); or `removed` when the work was removed meanwhile, and
 * everything under its `works/` folder is deleted again.
 */
export async function saveBackfill(
  deps: { db: Kysely<Database>; bucket: SaveBucket },
  source: BackfillSource,
  work: ParsedWork,
  images: WorkImages = new Map(),
): Promise<"backfilled" | "not_current" | "removed"> {
  if (work.chapters.length === 0) throw new SaveRejected("no_chapters");
  const versionId = crypto.randomUUID();
  const prefix = `works/${source.ao3WorkId}/${versionId}/`;
  const chapters = await putFiles(deps.bucket, source.ao3WorkId, prefix, work, images);
  // The moderator's check stands only for the parser's doubts it answered.
  const sameReasons = sameSet(new Set(work.reviewReasons), new Set(source.reviewReasons));
  const origin: VersionOrigin = {
    id: versionId,
    upload_id: null,
    source: "backfill",
    source_upload_id: source.originalUploadId,
    checked_at: null,
  };
  try {
    await deps.db.transaction().execute(async (trx) => {
      await insertVersion(trx, origin, work, source.workId, prefix, chapters);
      // The copy below keeps the work's summary when the version has none. The work takes the
      // version's own instead, even none: a summary the fix emptied must not keep the markup it
      // let through, nor an older file's, sanitized the old way. Set first, so the copy
      // refreshes the search text from it; a lost race rolls it back with the rest.
      await trx
        .updateTable("works")
        .set({ summary_html: work.summaryHtml })
        .where("id", "=", source.workId)
        .where("current_version_id", "=", source.versionId)
        .execute();
      await replaceCurrent(trx, source.workId, source.versionId, versionId);
      // Read after the swap, not with the work: a check a moderator made while the file was
      // processed carries over too.
      if (sameReasons) {
        await trx
          .updateTable("work_versions")
          .set((eb) => ({
            checked_at: eb
              .selectFrom("work_versions as source")
              .select("source.checked_at")
              .where("source.id", "=", source.versionId),
          }))
          .where("id", "=", versionId)
          .execute();
      }
    });
    return "backfilled";
  } catch (error) {
    if (!(error instanceof Stale)) throwSaveError(error);
  }
  // `now()` keeps Hyperdrive from answering from its cache: a stale `live` would leave behind
  // what this job put back after a removal.
  const row = await deps.db
    .selectFrom("works")
    .select(["status", sql<Date>`now()`.as("read_at")])
    .where("id", "=", source.workId)
    .executeTakeFirst();
  if (row !== undefined && row.status !== "removed") return "not_current";
  // Removed while the job ran: its purge may have run before these writes, so what they put
  // back is deleted here.
  await clearRemovedWork(deps.bucket, source.ao3WorkId);
  return "removed";
}

/**
 * Makes `versionId` the work's current version, as a replace and a backfill do: one statement
 * moves the pointer only if it is still `from`, where it was read (a compare-and-swap), then
 * the work describes the version (its columns, a field the file lacks keeping the work's
 * value, its byline and tags, and the search text). A job that lost the race matches no row
 * and throws `Stale`, so the transaction rolls back. A winner holds the row lock from here to
 * its commit, so everything after it is one job's at a time. Status is left as it is: this
 * never unhides a hidden work, and a work removed since the read isn't moved.
 */
async function replaceCurrent(
  trx: Transaction<Database>,
  workId: string,
  from: string,
  versionId: string,
): Promise<void> {
  const moved = await trx
    .updateTable("works")
    .set({ current_version_id: versionId })
    .where("id", "=", workId)
    .where("current_version_id", "=", from)
    .where("status", "<>", "removed")
    .returning("id")
    .executeTakeFirst();
  if (moved === undefined) throw new Stale();
  await copyVersionToWork(trx, workId, versionId);
}

/**
 * Throws a save's failure. Class 21 (cardinality, such as two of the file's
 * tags landing on one row), 22 (data exception), 23 (integrity constraint) and 54 (program
 * limit, such as an index row too large): the file's own data broke a rule, and will again, so
 * it is thrown as a `SaveRejected`. Anything else, such as a lost connection, is worth a retry
 * and is thrown as it is.
 */
// oxlint-disable-next-line deslop/no-unknown-parameters -- a caught value is unknown by contract
function throwSaveError(error: unknown): never {
  const state = sqlState(error);
  if (isDataErrorState(state)) {
    throw new SaveRejected(`save_rejected_${state}`);
  }
  throw error;
}

/**
 * The work's current version as `decideVersion` sees it, or null when no work has the AO3 ID.
 * The pointer is read first: a save that commits after it moves the pointer, and the write
 * that relies on these facts fails then (`Stale`).
 */
async function readCurrent(
  deps: { db: Kysely<Database>; bucket: SaveBucket },
  ao3WorkId: number,
): Promise<Current | null> {
  const work = await deps.db
    .selectFrom("works")
    .select(["id", "status", "current_version_id", "updated_at"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  if (work === undefined) return null;
  // Before the version's fragments are read (removal purges them) and before any write.
  if (work.status === "removed") throw new WorkRemoved();
  // A committed work always has one: a failure worth a retry, not a verdict on the file.
  if (work.current_version_id === null) throw new Error("a saved work has no current version");
  const versionId = work.current_version_id;
  const [chapters, tags, authors, source] = await Promise.all([
    deps.db
      .selectFrom("chapters")
      .select(["n", "r2_key"])
      .where("version_id", "=", versionId)
      .execute(),
    deps.db
      .selectFrom("work_tags")
      .innerJoin("tags", "tags.id", "work_tags.tag_id")
      .select(["tags.type", "tags.name"])
      .where("work_tags.work_id", "=", work.id)
      .orderBy("work_tags.position")
      .execute(),
    deps.db
      .selectFrom("work_authors")
      .select(["pseud", "ao3_user"])
      .where("work_id", "=", work.id)
      .orderBy("position")
      .execute(),
    // The upload the version was made from: a backfill version's is the one it was re-made from.
    deps.db
      .selectFrom("work_versions")
      .innerJoin("uploads", (join) =>
        join.on(
          sql<boolean>`uploads.id = coalesce(work_versions.upload_id, work_versions.source_upload_id)`,
        ),
      )
      .select("uploads.format")
      .where("work_versions.id", "=", versionId)
      .executeTakeFirst(),
  ]);
  const texts: { n: number; text: string }[] = [];
  await inPool(chapters, async (c) => {
    const object = await deps.bucket.get(c.r2_key);
    if (object === null) {
      // A removal purges the fragments after it commits: the work's removal, not a fault.
      if (await isRemovedNow(deps.db, ao3WorkId)) throw new WorkRemoved();
      throw new Error("a current chapter fragment is missing");
    }
    texts.push({ n: c.n, text: await object.text() });
  });
  return {
    workId: work.id,
    versionId,
    facts: {
      date: work.updated_at === null ? null : new Date(work.updated_at).toISOString().slice(0, 10),
      chapters: texts,
      tags,
      authors: authors.map((a) => ({ pseud: a.pseud, user: a.ao3_user })),
      fromPdf: source?.format === "pdf",
    },
  };
}

/** The upload's own facts, in the same terms as the current version's. */
function factsOf(work: ParsedWork, fromPdf: boolean): VersionFacts {
  return {
    date: updatedAtOf(work)?.slice(0, 10) ?? null,
    chapters: work.chapters.map((c) => ({ n: c.n, text: c.html })),
    tags: distinctTags(work),
    authors: distinctAuthors(work),
    fromPdf,
  };
}

/** The Updated, else Completed, else Published date, as `works.updated_at` stores it. */
function updatedAtOf(work: ParsedWork): string | null {
  return (
    dateOrNull(work.stats.updated) ??
    dateOrNull(work.stats.completed) ??
    dateOrNull(work.stats.published)
  );
}

/**
 * The work's own columns, as the upload's file gives them: NULL for a field it lacks (the
 * parser gives an empty title for none), except the words, updated date and completion,
 * which are derived as before when the file doesn't state them.
 */
function workColumns(work: ParsedWork) {
  const total = int4OrNull(work.stats.chapters.total, 1);
  return {
    title: work.title === "" ? null : work.title,
    summary_html: work.summaryHtml,
    rating: work.rating,
    language: work.language,
    words: int4OrNull(work.stats.words, 0) ?? int4OrNull(sum(work.chapters.map((c) => c.words)), 0),
    chapters_count: work.chapters.length,
    chapters_total: total,
    complete:
      work.stats.completed !== null || work.stats.chapters.total === work.stats.chapters.posted,
    published_at: dateOrNull(work.stats.published),
    updated_at: updatedAtOf(work),
    raw_meta: JSON.stringify(work.rawMeta),
  };
}

/**
 * The upload's rows, in one transaction. `current` is the work as read before it (null when
 * no work had the ID) and `decision` what `decideVersion` made of it. A write that relies on
 * `current` throws `Stale` if another job's save has moved the work since.
 */
async function writeRows(
  trx: Transaction<Database>,
  lease: Lease,
  work: ParsedWork,
  ao3WorkId: number,
  prefix: string,
  chapters: Chapters,
  current: Current | null,
  decision: VersionDecision | null,
): Promise<void> {
  // First, with a key-share lock on the account to the commit. A ban that locked the account
  // first is waited for and seen here; one that comes after this lock waits for the save,
  // whose upload then counts as finished.
  if (await isUploaderBanned(trx, lease.id, { lock: true })) throw new AccountBanned();
  if (current === null || decision === null) {
    return writeFirst(trx, lease, work, ao3WorkId, prefix, chapters);
  }
  const { workId } = current;
  if (decision.outcome === "duplicate") {
    // Stored but not used: its files are kept, and no version row is written.
    await confirmPointer(trx, current);
    return endUpload(trx, lease, "duplicate", workId);
  }
  if (decision.outcome === "hold") {
    await confirmPointer(trx, current);
    // Its columns, tags and authors stay on the version, with the reason it was held: the
    // work's own are the current version's.
    await insertVersion(
      trx,
      { upload_id: lease.id },
      work,
      workId,
      prefix,
      chapters,
      decision.reason,
    );
    return endUpload(trx, lease, "held_for_review", workId);
  }
  // A replace. The version first (the pointer's foreign key needs it), then the pointer's
  // compare-and-swap. A `Stale` reads the work again, and refuses a work removed since.
  const versionId = await insertVersion(
    trx,
    { upload_id: lease.id },
    work,
    workId,
    prefix,
    chapters,
  );
  await replaceCurrent(trx, workId, current.versionId, versionId);
  await endUpload(trx, lease, "live", workId);
}

/** A work's first upload: the work, its byline and tags, its version, live last. */
async function writeFirst(
  trx: Transaction<Database>,
  lease: Lease,
  work: ParsedWork,
  ao3WorkId: number,
  prefix: string,
  chapters: Chapters,
): Promise<void> {
  // First, so a work another job created since the read is found before anything else is
  // written: the insert waits on the unique index for the other transaction, then conflicts.
  const row = await trx
    .insertInto("works")
    // The NOT NULL columns only: the copy below fills the work from its version.
    .values({ ao3_work_id: ao3WorkId, title: work.title, chapters_count: 0, complete: false })
    .onConflict((oc) => oc.column("ao3_work_id").doNothing())
    .returning("id")
    .executeTakeFirst();
  // That job's work is committed now: read it and decide as for any later upload.
  if (row === undefined) throw new Stale();
  const workId = row.id;
  const versionId = await insertVersion(
    trx,
    { upload_id: lease.id },
    work,
    workId,
    prefix,
    chapters,
  );
  // The work describes its version, as after any replace: the byline, tags and search text,
  // in this transaction.
  await copyVersionToWork(trx, workId, versionId);
  // The work's last write: it goes `live` with its version current.
  await trx
    .updateTable("works")
    .set({ current_version_id: versionId, status: "live" })
    .where("id", "=", workId)
    .execute();
  await endUpload(trx, lease, "live", workId);
}

/**
 * Throws `Stale` unless the work's pointer is still the one the decision was made against, and
 * `WorkRemoved` when the work has been removed since the read.
 * The row stays locked shared to the end of the transaction, so a replace waits for it and
 * can't move the pointer from under the decision.
 */
async function confirmPointer(trx: Transaction<Database>, current: Current): Promise<void> {
  const row = await trx
    .selectFrom("works")
    .select("status")
    .where("id", "=", current.workId)
    .where("current_version_id", "=", current.versionId)
    .forShare()
    .executeTakeFirst();
  if (row === undefined) throw new Stale();
  if (row.status === "removed") throw new WorkRemoved();
}

/**
 * What made a version: an upload, or a backfill, which names its own id (its prefix holds it),
 * the upload it was re-made from, and the moderator's check it carries over.
 */
type VersionOrigin =
  | { upload_id: string }
  | {
      id: string;
      upload_id: null;
      source: "backfill";
      source_upload_id: string;
      checked_at: Date | null;
    };

/**
 * The version row and its chapters, with `holdReason` for a held version. Returns the
 * version's id.
 */
async function insertVersion(
  trx: Transaction<Database>,
  origin: VersionOrigin,
  work: ParsedWork,
  workId: string,
  prefix: string,
  chapters: Chapters,
  holdReason: HoldReason | null = null,
): Promise<string> {
  const { chapters_count: count, chapters_total: total, ...own } = workColumns(work);
  const version = await trx
    .insertInto("work_versions")
    .values({
      work_id: workId,
      ...origin,
      chapter_count: count,
      chapter_total: total,
      r2_prefix: prefix,
      review_reasons: work.reviewReasons,
      // Kept with the version, as `works` holds only the current one's: what the file had,
      // which a replace, a make-current or a moderator's approval copies onto the work.
      ...own,
      tags: JSON.stringify(distinctTags(work)),
      authors: JSON.stringify(distinctAuthors(work)),
      hold_reason: holdReason,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const rows = chapters.map((c) => ({
    work_id: workId,
    version_id: version.id,
    n: c.n,
    title: c.title,
    words: c.words,
    r2_key: c.key,
  }));
  for (const part of chunks(rows)) await trx.insertInto("chapters").values(part).execute();
  return version.id;
}

/**
 * Records the outcome. Fenced on the lease, as every ending write is: a job that lost its
 * upload publishes nothing, and the job that took it over records the outcome.
 */
async function endUpload(
  trx: Transaction<Database>,
  lease: Lease,
  status: Extract<UploadStatus, "live" | "held_for_review" | "duplicate">,
  workId: string,
): Promise<void> {
  const upload = await trx
    .updateTable("uploads")
    .set({
      status,
      work_id: workId,
      lease_until: null,
      error_stage: null,
      error: null,
      sha256: lease.sha256,
      format: lease.format,
    })
    .where("id", "=", lease.id)
    .where("status", "=", "processing")
    .where("lease_until", "=", lease.until)
    .returning("id")
    .executeTakeFirst();
  if (upload === undefined) throw new LeaseLost();
}

/** The work's tags, a repeated one keeping its first place. */
const distinctTags = (work: ParsedWork) => uniqueBy(tagsOf(work), tagKey);

/** The byline, a repeated entry keeping its first place. */
const distinctAuthors = (work: ParsedWork) =>
  uniqueBy(work.authors, authorKey).map((a) => ({ pseud: a.pseud, user: a.user }));

const tagKey = (t: { type: TagType; name: string }) => JSON.stringify([t.type, t.name]);
const authorKey = (a: { pseud: string; user: string | null }) => JSON.stringify([a.pseud, a.user]);

/** The AO3 work ID as the `works` key, an int4. A file whose ID doesn't fit is refused. */
function workIdOf(work: ParsedWork): number {
  const id = parseWorkId(work.ao3WorkId);
  if (id === null) throw new SaveRejected("bad_work_id");
  return id;
}

/** The work's tags in the author's order, by type as the preface lists them. */
function tagsOf(work: ParsedWork): { type: TagType; name: string }[] {
  const of = (type: TagType, names: string[]) => names.map((name) => ({ type, name }));
  return [
    ...of("rating", work.rating === null ? [] : [work.rating]),
    ...of("warning", work.warnings),
    ...of("category", work.categories),
    ...of("fandom", work.fandoms),
    ...of("relationship", work.relationships),
    ...of("character", work.characters),
    ...of("freeform", work.freeforms),
  ];
}

/** An int4 at least `min`, or NULL: an unknown or impossible count is stored as unknown. */
function int4OrNull(value: number | null, min: number): number | null {
  return value !== null && Number.isInteger(value) && value >= min && value <= MAX_INT4
    ? value
    : null;
}

/** A `YYYY-MM-DD` stat as a UTC timestamp, or NULL for anything that isn't a real date. */
function dateOrNull(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001") return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
    ? date.toISOString()
    : null;
}

/** `items` in runs of at most `ROWS_PER_INSERT`, in order. None for no items. */
function chunks<T>(items: T[]): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += ROWS_PER_INSERT) {
    runs.push(items.slice(i, i + ROWS_PER_INSERT));
  }
  return runs;
}

/** The first of each key, in order. */
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Runs `fn` on each item, at most `PUT_POOL` at once. */
async function inPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  // One iterator shared by the workers: each takes the next item when it is free. After a
  // failure none takes another, so a job R2 is failing stops sending writes.
  const queue = items.values();
  let failed = false;
  const worker = async () => {
    for (const item of queue) {
      if (failed) return;
      try {
        await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PUT_POOL, items.length) }, worker));
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
