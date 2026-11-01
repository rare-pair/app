// Copies a version onto its work, and writes a work's byline and tags. Shared by ingest's
// replace and first upload, make-current, approval and the seed helper. It imports only
// Kysely and pure modules, so ingest and the seed module, which load in workerd, can use it.
import { sql, type Kysely } from "kysely";
import type { Database, VersionAuthor, VersionTag } from "./schema";
import { refreshWorkSearch } from "./search-index";
import { compareTagKeys, normalizeTagName } from "./tags";

/** Rows per INSERT, so a long byline or tag list stays far under Postgres's 65,535 bind parameters. */
const ROWS_PER_INSERT = 1_000;

/**
 * Makes the work describe one of its versions: each of the version's columns that isn't NULL
 * is copied onto the work, and a NULL one (a field the version's file lacked, or a version
 * saved before migration 0012) keeps the work's value. The counts come from the version's
 * chapters. The byline and tags are rewritten from the version's own, unless they are NULL
 * (a version saved before migration 0010), and the search text is refreshed. It leaves
 * `current_version_id` and `status` to the caller, which must already hold the work's row
 * lock in this transaction (it has moved the pointer, or locked the row), so the copy and the
 * pointer are one writer's.
 */
export async function copyVersionToWork(
  trx: Kysely<Database>,
  workId: string,
  versionId: string,
): Promise<void> {
  const copied = await sql<{ tags: VersionTag[] | null; authors: VersionAuthor[] | null }>`
    update works set
      title = coalesce(v.title, works.title),
      summary_html = coalesce(v.summary_html, works.summary_html),
      rating = coalesce(v.rating, works.rating),
      language = coalesce(v.language, works.language),
      words = coalesce(v.words, works.words),
      chapters_count = v.chapter_count,
      chapters_total = coalesce(v.chapter_total, works.chapters_total),
      complete = coalesce(v.complete, works.complete),
      published_at = coalesce(v.published_at, works.published_at),
      updated_at = coalesce(v.updated_at, works.updated_at),
      raw_meta = coalesce(v.raw_meta, works.raw_meta)
    from work_versions v
    where works.id = ${workId} and v.id = ${versionId} and v.work_id = works.id
    returning v.tags, v.authors`.execute(trx);
  const version = copied.rows[0];
  // The callers pass one of the work's own versions: a miss is a bug, not a bad request.
  if (version === undefined) throw new Error("the version is not one of the work's");
  if (version.authors !== null) {
    await trx.deleteFrom("work_authors").where("work_id", "=", workId).execute();
    await writeWorkAuthors(trx, workId, version.authors);
  }
  if (version.tags !== null) {
    await trx.deleteFrom("work_tags").where("work_id", "=", workId).execute();
    await writeWorkTags(trx, workId, version.tags);
  }
  await refreshWorkSearch(trx, workId);
}

/** Inserts the work's byline in the order given. The work must have none yet. */
async function writeWorkAuthors(
  trx: Kysely<Database>,
  workId: string,
  authors: VersionAuthor[],
): Promise<void> {
  const rows = authors.map((a, position) => ({
    work_id: workId,
    pseud: a.pseud,
    ao3_user: a.user,
    position,
  }));
  for (const part of chunks(rows)) await trx.insertInto("work_authors").values(part).execute();
}

/**
 * Upserts the tags and links them to the work in the order given. The work must have none
 * yet, and each tag must appear once.
 */
async function writeWorkTags(
  trx: Kysely<Database>,
  workId: string,
  tags: VersionTag[],
): Promise<void> {
  const placed = tags.map((tag, position) => ({ type: tag.type, name: tag.name, position }));
  // Upserted in the shared lock order, a statement of rows at a time (Postgres takes a
  // statement's rows in VALUES order), so concurrent writers sharing tags can't deadlock. The
  // update makes RETURNING give an existing tag's id, and brings its `name_norm` up to the rule.
  const ids = new Map<string, string>();
  const sorted = placed.slice().sort(compareTagKeys);
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
  const idOf = (t: VersionTag) => {
    const id = ids.get(tagKey(t));
    // Every row inserted or updated is returned: a miss is a bug here, not a bad file.
    if (id === undefined) throw new Error("an upserted tag was not returned");
    return id;
  };
  const rows = placed.map((t) => ({ work_id: workId, tag_id: idOf(t), position: t.position }));
  for (const part of chunks(rows)) await trx.insertInto("work_tags").values(part).execute();
}

const tagKey = (t: VersionTag) => JSON.stringify([t.type, t.name]);

/** `items` in runs of at most `ROWS_PER_INSERT`, in order. None for no items. */
function chunks<T>(items: T[]): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += ROWS_PER_INSERT) {
    runs.push(items.slice(i, i + ROWS_PER_INSERT));
  }
  return runs;
}
