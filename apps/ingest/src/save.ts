import {
  compareTagKeys,
  normalizeTagName,
  refreshWorkSearch,
  type Database,
  type TagType,
  type UploadStatus,
} from "@archive/db";
import type { ParsedWork } from "@archive/epub";
import type { Kysely, Transaction } from "kysely";
import type { Lease } from "./lease";
import { decideVersion, type VersionDecision, type VersionFacts } from "./versioning";

/** What saving needs from the bucket: writes, and reads of the current version's fragments. */
export interface SaveBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | Uint8Array, options?: R2PutOptions): Promise<R2Object | null>;
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
 * `work_removed`, at once, since the work stays removed until a moderator restores it.
 */
export class WorkRemoved extends Error {}

/** The job no longer holds its upload: another job has taken it over, and owns the row. */
export class LeaseLost extends Error {}

/**
 * The work changed between this job's read of it and its write: another job's save committed
 * first. The transaction rolls back, and the save reads the work again and decides again.
 */
class Stale extends Error {}

const MAX_INT4 = 2_147_483_647;
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
 * stores no version (`duplicate`). Every outcome keeps the files. A failure before or inside
 * the transaction leaves no rows, only R2 objects: under keys a retry overwrites when it is
 * worth one, and left for the cleanup rules (#177) when the file is refused.
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
  // Read before the writes below and never inside the transaction: the current version's text
  // comes from R2, which is slow, and a row lock must not be held across it.
  let current = await readCurrent(deps, ao3WorkId);
  const facts = factsOf(work);
  const prefix = `works/${ao3WorkId}/${lease.id}/`;
  const chapters = work.chapters.map((c) => ({ ...c, key: `${prefix}${c.n}.html` }));
  await inPool(chapters, async (c) => {
    await deps.bucket.put(c.key, c.html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  });
  // Outside the upload's prefix, shared by every version of the work: keyed by the bytes, so a
  // retry writes the same keys.
  await inPool([...images], async ([key, image]) => {
    await deps.bucket.put(`works/${ao3WorkId}/img/${key}`, image.bytes, {
      httpMetadata: { contentType: image.mediaType },
    });
  });
  await deps.bucket.put(`originals/${lease.id}.epub`, bytes, {
    httpMetadata: { contentType: "application/epub+zip" },
  });
  for (let attempt = 1; ; attempt++) {
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
      if (error instanceof SaveRejected || error instanceof LeaseLost) throw error;
      if (error instanceof WorkRemoved) throw error;
      if (error instanceof Stale) {
        // Read the work as the other job left it and decide again: a second upload of the same
        // newer version, say, is now a duplicate. Out of attempts, it is a failure worth a retry.
        if (attempt >= MAX_ATTEMPTS) throw new Error("the work kept changing under the save");
        current = await readCurrent(deps, ao3WorkId);
        continue;
      }
      const state = sqlState(error);
      // Class 21 (cardinality, such as two of the file's tags landing on one row), 22 (data
      // exception), 23 (integrity constraint) and 54 (program limit, such as an index row too
      // large): the file's own data broke a rule, and will again. Anything else, such as a lost
      // connection, is worth a retry.
      if (state !== null && /^(21|22|23|54)/.test(state)) {
        throw new SaveRejected(`save_rejected_${state}`);
      }
      throw error;
    }
  }
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
  const [chapters, tags, authors] = await Promise.all([
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
  ]);
  const texts: { n: number; text: string }[] = [];
  await inPool(chapters, async (c) => {
    const object = await deps.bucket.get(c.r2_key);
    if (object === null) throw new Error("a current chapter fragment is missing");
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
    },
  };
}

/** The upload's own facts, in the same terms as the current version's. */
function factsOf(work: ParsedWork): VersionFacts {
  return {
    date: updatedAtOf(work)?.slice(0, 10) ?? null,
    chapters: work.chapters.map((c) => ({ n: c.n, text: c.html })),
    tags: distinctTags(work),
    authors: distinctAuthors(work),
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

/** The work's own columns, as the upload's file gives them. */
function workColumns(work: ParsedWork) {
  const total = int4OrNull(work.stats.chapters.total, 1);
  return {
    title: work.title,
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
    // Its tags and authors stay on the version: the work's own are the current version's.
    await insertVersion(trx, lease, work, workId, prefix, chapters);
    return endUpload(trx, lease, "held_for_review", workId);
  }
  // A replace. The version first (the pointer's foreign key needs it), then one statement that
  // moves the pointer only if it is still where it was read: a compare-and-swap. A job that lost
  // the race matches no row, and the transaction rolls back. A winner holds the row lock from
  // here to its commit, so everything after it is one job's at a time. Status is left as it is:
  // a replace never unhides a hidden or removed work.
  const versionId = await insertVersion(trx, lease, work, workId, prefix, chapters);
  const moved = await trx
    .updateTable("works")
    .set({ ...workColumns(work), current_version_id: versionId })
    .where("id", "=", workId)
    .where("current_version_id", "=", current.versionId)
    // A work removed since the read isn't moved: `Stale` reads it again and refuses it.
    .where("status", "<>", "removed")
    .returning("id")
    .executeTakeFirst();
  if (moved === undefined) throw new Stale();
  await trx.deleteFrom("work_authors").where("work_id", "=", workId).execute();
  await trx.deleteFrom("work_tags").where("work_id", "=", workId).execute();
  await writeAuthors(trx, workId, work);
  await writeTags(trx, workId, work);
  await refreshWorkSearch(trx, workId);
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
    .values({ ao3_work_id: ao3WorkId, ...workColumns(work) })
    .onConflict((oc) => oc.column("ao3_work_id").doNothing())
    .returning("id")
    .executeTakeFirst();
  // That job's work is committed now: read it and decide as for any later upload.
  if (row === undefined) throw new Stale();
  const workId = row.id;
  await writeAuthors(trx, workId, work);
  await writeTags(trx, workId, work);
  const versionId = await insertVersion(trx, lease, work, workId, prefix, chapters);
  // The index follows the title, byline and tags just written, in this transaction.
  await refreshWorkSearch(trx, workId);
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

/** The version row and its chapters. Returns the version's id. */
async function insertVersion(
  trx: Transaction<Database>,
  lease: Lease,
  work: ParsedWork,
  workId: string,
  prefix: string,
  chapters: Chapters,
): Promise<string> {
  const version = await trx
    .insertInto("work_versions")
    .values({
      work_id: workId,
      upload_id: lease.id,
      chapter_count: work.chapters.length,
      chapter_total: int4OrNull(work.stats.chapters.total, 1),
      r2_prefix: prefix,
      review_reasons: work.reviewReasons,
      // Kept with the version, as `works` holds only the current one's: a held version's are
      // what a moderator's approval applies.
      tags: JSON.stringify(distinctTags(work)),
      authors: JSON.stringify(distinctAuthors(work)),
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
    .set({ status, work_id: workId, lease_until: null, error_stage: null, error: null })
    .where("id", "=", lease.id)
    .where("status", "=", "processing")
    .where("lease_until", "=", lease.until)
    .returning("id")
    .executeTakeFirst();
  if (upload === undefined) throw new LeaseLost();
}

/** The byline's unique keys: a repeated entry keeps its first place. */
async function writeAuthors(
  trx: Transaction<Database>,
  workId: string,
  work: ParsedWork,
): Promise<void> {
  const bylines = distinctAuthors(work).map((a, position) => ({
    work_id: workId,
    pseud: a.pseud,
    ao3_user: a.user,
    position,
  }));
  for (const part of chunks(bylines)) await trx.insertInto("work_authors").values(part).execute();
}

/** A tag given twice keeps its first place. */
async function writeTags(
  trx: Transaction<Database>,
  workId: string,
  work: ParsedWork,
): Promise<void> {
  const tags = distinctTags(work).map((tag, position) => ({ ...tag, position }));
  // Upserted in the shared lock order, a statement of rows at a time (Postgres takes a
  // statement's rows in VALUES order), so concurrent ingests sharing tags can't deadlock. The
  // update makes RETURNING give an existing tag's id, and brings its `name_norm` up to the rule.
  const ids = new Map<string, string>();
  const sorted = tags.slice().sort(compareTagKeys);
  for (const part of chunks(sorted)) {
    const rows = await trx
      .insertInto("tags")
      .values(
        part.map((t) => ({
          type: t.type,
          name: t.name,
          name_norm: normalizeTagName(t.type, t.name),
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(["type", "name"])
          .doUpdateSet((eb) => ({ name_norm: eb.ref("excluded.name_norm") })),
      )
      .returning(["id", "type", "name"])
      .execute();
    for (const r of rows) ids.set(tagKey(r), r.id);
  }
  const idOf = (t: { type: TagType; name: string }) => {
    const id = ids.get(tagKey(t));
    // Every row inserted or updated is returned: a miss is a bug here, not a bad file.
    if (id === undefined) throw new Error("an upserted tag was not returned");
    return id;
  };
  const workTags = tags.map((t) => ({ work_id: workId, tag_id: idOf(t), position: t.position }));
  for (const part of chunks(workTags)) await trx.insertInto("work_tags").values(part).execute();
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
  const id = Number(work.ao3WorkId);
  if (!/^[1-9]\d{0,9}$/.test(work.ao3WorkId) || id > MAX_INT4) {
    throw new SaveRejected("bad_work_id");
  }
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

/** A Postgres error's SQLSTATE, or null. pg's errors carry it as `code`. */
// oxlint-disable-next-line deslop/no-unknown-parameters -- a caught value is unknown by contract
function sqlState(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = String(error.code);
  return /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
