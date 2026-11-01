// Typed reads and writes over the catalogue and uploads. Each takes the
// caller's Kysely, so a Worker passes the one it made for the request.
import { sql, type ExpressionBuilder, type Kysely, type Selectable } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import type {
  ChapterTable,
  Database,
  HiddenCause,
  TagTable,
  TagType,
  WorkTable,
  WorkVersionTable,
} from "./schema";
import { compareCodeUnits, normalizeTagName } from "./tags";

/** A work's own fields, as a page shows them. */
export type WorkSummary = Pick<
  Selectable<WorkTable>,
  | "id"
  | "ao3_work_id"
  | "title"
  | "summary_html"
  | "rating"
  | "language"
  | "words"
  | "chapters_count"
  | "chapters_total"
  | "complete"
  | "published_at"
  | "updated_at"
  | "status"
>;

export interface LiveWork {
  work: WorkSummary;
  /** In byline order. */
  authors: { pseud: string; ao3_user: string | null }[];
  /** In the author's order. */
  tags: Selectable<TagTable>[];
  version: Pick<
    Selectable<WorkVersionTable>,
    | "id"
    | "chapter_count"
    | "chapter_total"
    | "r2_prefix"
    | "created_at"
    | "review_reasons"
    | "checked_at"
  >;
  /** The current version's chapters, by number. */
  chapters: Pick<Selectable<ChapterTable>, "n" | "title" | "words" | "r2_key">[];
}

const SUMMARY = [
  "works.id",
  "works.ao3_work_id",
  "works.title",
  "works.summary_html",
  "works.rating",
  "works.language",
  "works.words",
  "works.chapters_count",
  "works.chapters_total",
  "works.complete",
  "works.published_at",
  "works.updated_at",
  "works.status",
] as const;

const MAX_INT4 = 2_147_483_647;

/** Why a work is withheld from readers: hidden for a cause, or removed. */
export type WorkAvailability = { status: "hidden"; cause: HiddenCause } | { status: "removed" };

/**
 * Whether a work is withheld, by its AO3 work ID: its status and hide cause and
 * nothing else, so a removed work answers even once its version rows are purged.
 * Null for a `live` or `processing` work, an unknown one or an ID that is no int4.
 * This is the one place a page learns "hidden" or "removed".
 */
export async function getWorkAvailability(
  db: Kysely<Database>,
  ao3WorkId: number,
): Promise<WorkAvailability | null> {
  if (!Number.isInteger(ao3WorkId) || ao3WorkId < 1 || ao3WorkId > MAX_INT4) return null;
  const row = await db
    .selectFrom("works")
    .select(["works.status", "works.hidden_cause"])
    .where("works.ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  if (row?.status === "removed") return { status: "removed" };
  // The schema's check makes hidden_cause non-null exactly while hidden.
  if (row?.status === "hidden" && row.hidden_cause !== null) {
    return { status: "hidden", cause: row.hidden_cause };
  }
  return null;
}

/**
 * A `live` work by its AO3 work ID, with its authors, tags and current
 * version's chapters. Null when there is none, or it's hidden or removed.
 */
export async function getLiveWork(
  db: Kysely<Database>,
  ao3WorkId: number,
): Promise<LiveWork | null> {
  // `ao3_work_id` is an int4: anything else is no work, not a database error.
  if (!Number.isInteger(ao3WorkId) || ao3WorkId < 1 || ao3WorkId > MAX_INT4) return null;
  // One statement, so the work, its version, byline, tags and chapters all
  // come from one snapshot even while a moderator switches versions (a cached
  // result through Hyperdrive is consistent, though not necessarily fresh).
  // json_agg doesn't promise its input order, so the lists are sorted here.
  const row = await db
    .selectFrom("works")
    .innerJoin("work_versions", "work_versions.id", "works.current_version_id")
    .select(SUMMARY)
    .select([
      "work_versions.id as version_id",
      "work_versions.chapter_count",
      "work_versions.chapter_total",
      "work_versions.r2_prefix",
      "work_versions.created_at",
      "work_versions.review_reasons",
      "work_versions.checked_at",
    ])
    .select((eb) => [
      jsonArrayFrom(
        eb
          .selectFrom("work_authors")
          .select(["work_authors.pseud", "work_authors.ao3_user", "work_authors.position"])
          .whereRef("work_authors.work_id", "=", "works.id"),
      ).as("authors"),
      jsonArrayFrom(
        eb
          .selectFrom("work_tags")
          .innerJoin("tags", "tags.id", "work_tags.tag_id")
          .select(["tags.id", "tags.type", "tags.name", "tags.name_norm", "work_tags.position"])
          .whereRef("work_tags.work_id", "=", "works.id"),
      ).as("tags"),
      jsonArrayFrom(
        eb
          .selectFrom("chapters")
          .select(["chapters.n", "chapters.title", "chapters.words", "chapters.r2_key"])
          .whereRef("chapters.version_id", "=", "work_versions.id"),
      ).as("chapters"),
    ])
    .where("works.ao3_work_id", "=", ao3WorkId)
    .where("works.status", "=", "live")
    .executeTakeFirst();
  if (!row) return null;
  const {
    version_id,
    chapter_count,
    chapter_total,
    r2_prefix,
    created_at,
    review_reasons,
    checked_at,
    authors,
    tags,
    chapters,
    ...work
  } = row;
  return {
    work,
    authors: authors
      .sort((a, b) => a.position - b.position)
      .map(({ pseud, ao3_user }) => ({ pseud, ao3_user })),
    tags: tags
      .sort((a, b) => a.position - b.position)
      .map(({ id, type, name, name_norm }) => ({ id, type, name, name_norm })),
    version: {
      id: version_id,
      chapter_count,
      chapter_total,
      r2_prefix,
      created_at,
      review_reasons,
      checked_at,
    },
    chapters: chapters.sort((a, b) => a.n - b.n),
  };
}

/** A work as a listing's card shows it. */
export type ListedWork = Pick<LiveWork, "work" | "authors" | "tags">;

/** A card's byline and tags, as sub-selects of the `works` row they hang from. */
const bylineAndTags = (eb: ExpressionBuilder<Database, "works">) => [
  jsonArrayFrom(
    eb
      .selectFrom("work_authors")
      .select(["work_authors.pseud", "work_authors.ao3_user", "work_authors.position"])
      .whereRef("work_authors.work_id", "=", "works.id"),
  ).as("authors"),
  jsonArrayFrom(
    eb
      .selectFrom("work_tags")
      .innerJoin("tags", "tags.id", "work_tags.tag_id")
      .select(["tags.id", "tags.type", "tags.name", "tags.name_norm", "work_tags.position"])
      .whereRef("work_tags.work_id", "=", "works.id"),
  ).as("tags"),
];

type CardRow = WorkSummary & {
  authors: { pseud: string; ao3_user: string | null; position: number }[];
  tags: (Pick<Selectable<TagTable>, "id" | "type" | "name" | "name_norm"> & { position: number })[];
};

/** A row with its sub-selects as a listed work. As in getLiveWork, json_agg's order isn't promised, so the lists are sorted here. */
const asListed = ({ authors, tags, ...work }: CardRow): ListedWork => ({
  work,
  authors: authors
    .sort((a, b) => a.position - b.position)
    .map(({ pseud, ao3_user }) => ({ pseud, ao3_user })),
  tags: tags
    .sort((a, b) => a.position - b.position)
    .map(({ id, type, name, name_norm }) => ({ id, type, name, name_norm })),
});

/**
 * The names a listing of `name` matches: `name` under the tag rule, and `name`
 * itself, since a tag link carries a stored `name_norm` and the rule isn't
 * idempotent for a few letters (NFKC can compose what lowercasing left). Empty
 * when it names no tag: it folds to nothing, or holds a NUL, which Postgres refuses.
 */
export function tagNameKeys(type: TagType, name: string): string[] {
  const nameNorm = normalizeTagName(type, name);
  if (nameNorm === "" || name.includes("\0")) return [];
  return nameNorm === name ? [name] : [nameNorm, name];
}

/**
 * How the live works carrying this tag spell it, each once, by code unit. Only
 * live works count, so a hidden or removed work's spelling is never shown.
 */
export async function liveTagSpellings(
  db: Kysely<Database>,
  type: TagType,
  name: string,
): Promise<string[]> {
  const keys = tagNameKeys(type, name);
  if (keys.length === 0) return [];
  const rows = await db
    .selectFrom("tags")
    .innerJoin("work_tags", "work_tags.tag_id", "tags.id")
    .innerJoin("works", "works.id", "work_tags.work_id")
    .select("tags.name")
    .distinct()
    .where("works.status", "=", "live")
    .where("tags.type", "=", type)
    .where("tags.name_norm", "in", keys)
    .execute();
  // By code unit, not by the database's collation.
  return rows.map((r) => r.name).sort(compareCodeUnits);
}

/** The rating a page shows for a work with none, and the filter that also finds those. */
export const NOT_RATED = "Not Rated";

/** A page of a tag listing, and how many works the listing holds in all. */
export interface TagListing {
  works: ListedWork[];
  total: number;
}

/**
 * A listing's order: last updated (the updated date, else the published one),
 * newest first; or word count, longest first.
 */
export type ListingSort = "updated" | "words";

/** Which page of a listing to read, and in what order. Pages count from 1. */
export interface ListingOptions {
  sort?: ListingSort;
  /** Only works with this rating. "Not Rated" also finds works with none, as a card shows them. */
  rating?: string;
  /** Only works that also carry this tag, matched as the listing's own is. One that names nothing matches nothing. */
  tag?: { type: TagType; name: string };
  /** Only complete works, or only works in progress. */
  complete?: boolean;
  /** Default 1. One below 1, or not a whole number, is the first. */
  page?: number;
  /** Default 20, also for one below 1 or not a whole number. */
  pageSize?: number;
}

const PAGE_SIZE = 20;

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 1;

type WorksWhere = ExpressionBuilder<Database, "works">;

/** The work carries a tag of this type whose `name_norm` is one of `keys`. */
const tagged = (eb: WorksWhere, type: TagType, keys: string[]) =>
  eb.exists(
    eb
      .selectFrom("work_tags")
      .innerJoin("tags", "tags.id", "work_tags.tag_id")
      .select("work_tags.tag_id")
      .whereRef("work_tags.work_id", "=", "works.id")
      .where("tags.name_norm", "in", keys)
      .where("tags.type", "=", type),
  );

const rated = (eb: WorksWhere, rating: string) =>
  rating === NOT_RATED
    ? eb.or([
        eb("works.rating", "=", rating),
        eb("works.rating", "is", null),
        eb("works.rating", "=", ""),
      ])
    : eb("works.rating", "=", rating);

/**
 * The `live` works carrying a tag of this type that matches `name` under the
 * tag rule (`tagNameKeys`), however each work spelled it, with their bylines
 * and tags: one page of them, and how many there are in all.
 */
export async function listLiveWorksByTag(
  db: Kysely<Database>,
  type: TagType,
  name: string,
  { sort = "updated", rating, tag, complete, page = 1, pageSize = PAGE_SIZE }: ListingOptions = {},
): Promise<TagListing> {
  const keys = tagNameKeys(type, name);
  const tagKeys = tag === undefined ? [] : tagNameKeys(tag.type, tag.name);
  if (keys.length === 0 || (tag !== undefined && tagKeys.length === 0)) {
    return { works: [], total: 0 };
  }
  const listed = (eb: WorksWhere) =>
    eb.and([
      eb("works.status", "=", "live"),
      tagged(eb, type, keys),
      ...(tag === undefined ? [] : [tagged(eb, tag.type, tagKeys)]),
      ...(rating === undefined ? [] : [rated(eb, rating)]),
      ...(complete === undefined ? [] : [eb("works.complete", "=", complete)]),
    ]);
  const { count } = await db
    .selectFrom("works")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where(listed)
    .executeTakeFirstOrThrow();
  const total = Number(count);
  const size = isCount(pageSize) ? pageSize : PAGE_SIZE;
  // A page past every safe integer is past the end, not the first.
  const offset = page > Number.MAX_SAFE_INTEGER ? total : isCount(page) ? (page - 1) * size : 0;
  if (offset >= total) return { works: [], total };
  const byKey =
    sort === "words" ? sql`works.words` : sql`coalesce(works.updated_at, works.published_at)`;
  // The page is cut first, so the bylines and tags are built for its rows alone,
  // not for every row an offset skips.
  const pageRows = db
    .selectFrom("works")
    .select(SUMMARY)
    .where(listed)
    .orderBy(byKey, (ob) => ob.desc().nullsLast())
    // AO3 work ID last: a total order, so pages read from one state of the works
    // neither repeat nor skip one. (A work that changes between page loads can.)
    .orderBy("works.ao3_work_id")
    .limit(size)
    .offset(offset);
  const rows = await db
    .selectFrom(pageRows.as("works"))
    .selectAll("works")
    .select(bylineAndTags)
    // A subquery's order isn't kept, so the page is put in order again.
    .orderBy(byKey, (ob) => ob.desc().nullsLast())
    .orderBy("works.ao3_work_id")
    .execute();
  return { works: rows.map(asListed), total };
}

/**
 * Inserts a `pending` upload. The caller may choose its id, so the R2 key can
 * name it before the row exists.
 */
export async function insertUpload(
  db: Kysely<Database>,
  upload: { id?: string; userId: string; r2Key: string; bytes: number },
): Promise<{ id: string; status: "pending" }> {
  const row = await db
    .insertInto("uploads")
    .values({ id: upload.id, user_id: upload.userId, r2_key: upload.r2Key, bytes: upload.bytes })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, status: "pending" };
}

export interface PopularFandom {
  /** How the live works spell it, the first by code unit when they differ. */
  name: string;
  name_norm: string;
  /** How many live works carry it. */
  count: number;
}

const POPULAR_FANDOMS = 10;
const RECENT_WORKS = 12;

/**
 * The fandoms the most live works carry, most first, each fandom being one
 * `name_norm`; ties by `name_norm`, by byte order. Only live works count, so a
 * fandom only hidden or removed works use, and its spelling, never shows.
 */
export async function listPopularFandoms(
  db: Kysely<Database>,
  limit = POPULAR_FANDOMS,
): Promise<PopularFandom[]> {
  const rows = await db
    .selectFrom("tags")
    .innerJoin("work_tags", "work_tags.tag_id", "tags.id")
    .innerJoin("works", "works.id", "work_tags.work_id")
    .select((eb) => [
      "tags.name_norm",
      eb.fn.count<string>("works.id").distinct().as("count"),
      sql<string[]>`array_agg(distinct tags.name)`.as("names"),
    ])
    .where("works.status", "=", "live")
    .where("tags.type", "=", "fandom")
    // A fandom that folds to nothing has no listing to link to.
    .where("tags.name_norm", "<>", "")
    .groupBy("tags.name_norm")
    .orderBy("count", "desc")
    .orderBy(sql`tags.name_norm collate "C"`)
    .limit(isCount(limit) ? limit : POPULAR_FANDOMS)
    .execute();
  return rows.map(({ name_norm, count, names }) => ({
    // By code unit, not by the database's collation.
    name: names.sort(compareCodeUnits)[0] ?? name_norm,
    name_norm,
    count: Number(count),
  }));
}

/**
 * The `live` works by when their first version was added here, newest first
 * (a later version doesn't make a work newer), with their bylines and tags.
 */
export async function listRecentLiveWorks(
  db: Kysely<Database>,
  limit = RECENT_WORKS,
): Promise<ListedWork[]> {
  const rows = await db
    .selectFrom("works")
    .innerJoin(
      (eb) =>
        eb
          .selectFrom("work_versions")
          .select([
            "work_versions.work_id",
            (e) => e.fn.min("work_versions.created_at").as("added_at"),
          ])
          .groupBy("work_versions.work_id")
          .as("first"),
      (join) => join.onRef("first.work_id", "=", "works.id"),
    )
    .select(SUMMARY)
    .select(bylineAndTags)
    .where("works.status", "=", "live")
    .orderBy("first.added_at", "desc")
    // AO3 work ID last, highest first: a total order, so a tie (one transaction
    // adds many works at one instant) reads the same each time.
    .orderBy("works.ao3_work_id", "desc")
    .limit(isCount(limit) ? limit : RECENT_WORKS)
    .execute();
  return rows.map(asListed);
}

/**
 * How many distinct accounts have an open report that counts toward hiding the
 * work, as a SQL expression. A `wrong_version` report never counts, and an
 * account counts once however often it reports. The one place this rule
 * lives: a later rule (a blocked requester's accounts) changes it here.
 */
const countedReporters = (workId: string) => sql<number>`(
  select count(distinct reports.reporter_id) from reports
  where reports.work_id = ${workId} and reports.status = 'open' and reports.kind <> 'wrong_version'
)`;

/**
 * Hides a `live` work with its cause, in one UPDATE that sets the status and
 * the cause together, as the schema's check requires. True when it hid it. A
 * hidden or removed work is left as it is, so no cause is overwritten, with one
 * exception: a moderator's hide takes over a hidden work's cause (a moderator has
 * looked at it, so an auto-hide no longer decides when it comes back).
 *
 * With `minReporters`, the work is hidden only when that many accounts have
 * counted reports (see `countedReporters`). The count sits inside the UPDATE,
 * not in a read before it: reads may come from Hyperdrive's cache and miss the
 * report just stored, but writes never do.
 */
export async function hideWork(
  db: Kysely<Database>,
  workId: string,
  cause: HiddenCause,
  options: { minReporters?: number } = {},
): Promise<boolean> {
  let update = db
    .updateTable("works")
    .set({ status: "hidden", hidden_cause: cause })
    .where("id", "=", workId)
    .where("status", "in", cause === "moderator" ? ["live", "hidden"] : ["live"]);
  if (options.minReporters !== undefined) {
    update = update.where(sql<boolean>`${countedReporters(workId)} >= ${options.minReporters}`);
  }
  const result = await update.executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/**
 * Makes a `hidden` work `live` again and clears its cause, in one UPDATE (the
 * schema's check allows a cause only while hidden), then closes the work's open
 * reports in the same transaction, so they stop counting toward `hideWork`'s
 * reporter count and the next report doesn't hide it again. True when it
 * restored it. With `cause`, only a work hidden for that cause comes back (a
 * rejected removal request lifts its own hide, not a moderator's). A live or
 * removed work is left as it is (a hidden work always has
 * a current version: the schema's check, so it can't come back without one).
 */
export async function restoreWork(
  db: Kysely<Database>,
  workId: string,
  options: { cause?: HiddenCause } = {},
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    let update = trx
      .updateTable("works")
      .set({ status: "live", hidden_cause: null })
      .where("id", "=", workId)
      .where("status", "=", "hidden");
    if (options.cause !== undefined) update = update.where("hidden_cause", "=", options.cause);
    const result = await update.executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    await trx
      .updateTable("reports")
      .set({ status: "closed" })
      .where("work_id", "=", workId)
      .where("status", "=", "open")
      .execute();
    return true;
  });
}
