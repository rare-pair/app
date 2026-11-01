import {
  compareTagKeys,
  normalizeTagName,
  refreshWorkSearch,
  type Database,
  type TagType,
} from "@archive/db";
import type { ParsedWork } from "@archive/epub";
import type { Kysely, Transaction } from "kysely";
import type { Lease } from "./lease";

/** What saving needs from the bucket: writes, by key. */
export interface SaveBucket {
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

/** The job no longer holds its upload: another job has taken it over, and owns the row. */
export class LeaseLost extends Error {}

const MAX_INT4 = 2_147_483_647;
/** R2 writes in flight at once: a Worker limits its simultaneous subrequests. */
const PUT_POOL = 6;
/** Rows per INSERT, so a long work stays far under Postgres's 65,535 bind parameters. */
const ROWS_PER_INSERT = 1_000;

/**
 * Saves the first upload of a work, in the order ingest promises (ARCHITECTURE, EPUB
 * processor, step 8): the chapter fragments under the upload's own prefix, the images under
 * the work's shared `img/` prefix (keyed by their bytes, left for the periodic sweep when no
 * version references them), then the raw file
 * to `originals/`, then one Postgres transaction that creates the work and its version and
 * sets it `live` last. A failure before or inside the transaction leaves no rows, only R2
 * objects: under keys a retry overwrites when it is worth one, and left for the cleanup
 * rules (#177) when the file is refused.
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
  // Refused before R2 is written, so a known work's upload leaves no fragments or original
  // copy. The transaction checks again, for two first uploads of one work at once.
  if (await workExists(deps.db, ao3WorkId)) throw new SaveRejected("work_exists");
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
  try {
    await deps.db
      .transaction()
      .execute((trx) => writeRows(trx, lease, work, ao3WorkId, prefix, chapters));
  } catch (error) {
    // The save's own refusals and a lost lease pass through as they are.
    if (error instanceof SaveRejected || error instanceof LeaseLost) throw error;
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

async function workExists(db: Kysely<Database>, ao3WorkId: number): Promise<boolean> {
  const row = await db
    .selectFrom("works")
    .select("id")
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  return row !== undefined;
}

/** The work's rows, in one transaction. The upload goes `live` with it, last. */
async function writeRows(
  trx: Transaction<Database>,
  lease: Lease,
  work: ParsedWork,
  ao3WorkId: number,
  prefix: string,
  chapters: (ParsedWork["chapters"][number] & { key: string })[],
): Promise<void> {
  const total = int4OrNull(work.stats.chapters.total, 1);
  const words =
    int4OrNull(work.stats.words, 0) ?? int4OrNull(sum(work.chapters.map((c) => c.words)), 0);
  // First, so a work another job created since the check above is found before anything else
  // is written. Later uploads of a known work are I4's (#33): until then they are refused.
  const row = await trx
    .insertInto("works")
    .values({
      ao3_work_id: ao3WorkId,
      title: work.title,
      summary_html: work.summaryHtml,
      rating: work.rating,
      language: work.language,
      words,
      chapters_count: work.chapters.length,
      chapters_total: total,
      complete:
        work.stats.completed !== null || work.stats.chapters.total === work.stats.chapters.posted,
      published_at: dateOrNull(work.stats.published),
      updated_at:
        dateOrNull(work.stats.updated) ??
        dateOrNull(work.stats.completed) ??
        dateOrNull(work.stats.published),
      raw_meta: JSON.stringify(work.rawMeta),
    })
    .onConflict((oc) => oc.column("ao3_work_id").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (row === undefined) throw new SaveRejected("work_exists");
  const workId = row.id;

  // The byline's unique keys: a repeated entry keeps its first place.
  const authors = uniqueBy(work.authors, (a) => JSON.stringify([a.pseud, a.user]));
  const bylines = authors.map((a, position) => ({
    work_id: workId,
    pseud: a.pseud,
    ao3_user: a.user,
    position,
  }));
  for (const part of chunks(bylines)) await trx.insertInto("work_authors").values(part).execute();

  // A tag given twice keeps its first place.
  const tagKey = (t: { type: TagType; name: string }) => JSON.stringify([t.type, t.name]);
  const tags = uniqueBy(tagsOf(work), tagKey).map((tag, position) => ({ ...tag, position }));
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

  const version = await trx
    .insertInto("work_versions")
    .values({
      work_id: workId,
      upload_id: lease.id,
      chapter_count: work.chapters.length,
      chapter_total: total,
      r2_prefix: prefix,
      review_reasons: work.reviewReasons,
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

  // The index follows the title, byline and tags just written, in this transaction.
  await refreshWorkSearch(trx, workId);

  // The work's last write: it goes `live` with its version current.
  await trx
    .updateTable("works")
    .set({ current_version_id: version.id, status: "live" })
    .where("id", "=", workId)
    .execute();
  // Fenced on the lease, as every ending write is: a job that lost its upload publishes
  // nothing, and the job that took it over records the outcome.
  const upload = await trx
    .updateTable("uploads")
    .set({ status: "live", work_id: workId, lease_until: null, error_stage: null, error: null })
    .where("id", "=", lease.id)
    .where("status", "=", "processing")
    .where("lease_until", "=", lease.until)
    .returning("id")
    .executeTakeFirst();
  if (upload === undefined) throw new LeaseLost();
}

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
