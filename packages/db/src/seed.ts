// Test-only helper, exported as `@archive/db/seed`: seeds works the way ingest
// leaves them. It loads in Node and in workerd alike, so it imports neither
// `pg` nor PGlite (nor `./index`, which pulls in `pg`): the caller passes its
// own Kysely. It writes no R2 object itself; `putFragments` does, in workerd,
// with the test's bucket binding. Text is synthetic: no fic text in tests.
// Default tags are shared rows: on a database several test files share, give
// each file its own tag names and AO3 work IDs, or a listing sees the others'.
import type { Kysely, Transaction } from "kysely";
import type { Database, HiddenCause, HoldReason, TagType } from "./schema";
import { copyVersionToWork } from "./version-copy";

export interface SeedChapter {
  title?: string;
  /** The fragment, as the sanitizer would leave it. Notes go inline. */
  html?: string;
  words?: number;
}

/**
 * A version's own columns, byline and tags. In `seedWork` each has the default given; in
 * `seedVersion` each defaults to the work's current value.
 */
export interface SeedVersionFields {
  title?: string;
  /** `summary_html`, as the sanitizer would leave it. Null for none. */
  summary?: string | null;
  rating?: string | null;
  complete?: boolean;
  /** AO3's last-updated date. Default 2020-02-01; null for none. */
  updatedAt?: string | null;
  authors?: { pseud: string; ao3_user: string | null }[];
  /** One author, stored as ingest stores an anonymous byline. Overrides `authors`. */
  anonymous?: boolean;
  /** In the author's order. */
  tags?: { type: TagType; name: string }[];
}

export interface SeedVersionOptions extends SeedVersionFields {
  /** A count, or each chapter. Default 1. */
  chapters?: number | SeedChapter[];
  /** The planned total. Default null: unknown, and a current version keeps the work's total. */
  chapterTotal?: number | null;
  reviewReasons?: string[];
  /** When the version was created here. Default: now. */
  addedAt?: string;
}

export interface SeedWorkOptions extends SeedVersionOptions {
  /** Default: a random one, so test files sharing a database don't collide. */
  ao3WorkId?: number;
  /** The uploader. Default: a new user. */
  userId?: string;
  /** Default `live`. A hidden work needs `hiddenCause`, or the schema refuses it. */
  status?: "live" | "hidden" | "removed";
  hiddenCause?: HiddenCause;
}

/** One chapter fragment to put in R2. */
export interface Fragment {
  key: string;
  body: string;
}

export interface SeededVersion {
  uploadId: string;
  versionId: string;
  /** `works/<ao3_work_id>/<upload_id>/` */
  r2Prefix: string;
  /** Each chapter's `r2_key`, by number. */
  chapterKeys: string[];
  fragments: Fragment[];
}

export interface SeededWork extends SeededVersion {
  workId: string;
  ao3WorkId: number;
  userId: string;
}

/** Anything with R2's `put`, such as a test's `env.BUCKET`. */
export interface FragmentBucket {
  // oxlint-disable-next-line deslop/no-unknown-returns -- R2's put returns an object nobody here reads
  put(key: string, value: string): Promise<unknown>;
}

/** After the rating tag, which follows the `rating` option. */
const DEFAULT_TAGS: { type: TagType; name: string }[] = [
  { type: "warning", name: "No Archive Warnings Apply" },
  { type: "category", name: "Gen" },
  { type: "fandom", name: "Seed Fandom" },
  { type: "relationship", name: "Seed One/Seed Two" },
  { type: "character", name: "Seed One" },
  { type: "freeform", name: "Seed Freeform" },
];

/**
 * Inserts a work as ingest leaves it: the work, its authors and tags, and one
 * `live` upload with its version and chapters, in one transaction. Returns the
 * ids, keys and fragments, so tests needn't hard-code them.
 */
export async function seedWork(
  db: Kysely<Database>,
  options: SeedWorkOptions = {},
): Promise<SeededWork> {
  const ao3WorkId = options.ao3WorkId ?? randomAo3WorkId();
  const status = options.status ?? "live";
  const rating = options.rating === undefined ? "General Audiences" : options.rating;
  const tags = options.tags ?? [
    ...(rating === null ? [] : [{ type: "rating" as const, name: rating }]),
    ...DEFAULT_TAGS,
  ];
  const columns: VersionColumns = {
    title: options.title ?? `Seeded work ${ao3WorkId}`,
    summary_html: options.summary === undefined ? "<p>A seeded summary.</p>" : options.summary,
    rating,
    language: "English",
    complete: options.complete ?? true,
    published_at: "2020-01-01T00:00:00Z",
    updated_at: options.updatedAt === undefined ? "2020-02-01T00:00:00Z" : options.updatedAt,
    authors: bylineOf(options) ?? [{ pseud: "Seed Author", user: "seed_author" }],
    tags: uniqueTags(tags),
  };
  return inTransaction(db, async (trx) => {
    const userId = options.userId ?? (await addUser(trx));
    const work = await trx
      .insertInto("works")
      // The version below sets the rest, the counts, byline and tags as it becomes current.
      .values({ ao3_work_id: ao3WorkId, title: columns.title, chapters_count: 0, complete: false })
      .returning("id")
      .executeTakeFirstOrThrow();
    const seeded = { workId: work.id, ao3WorkId, userId };
    const version = await addVersion(trx, seeded, columns, { ...options, current: true });
    // Last, as ingest does: the work leaves `processing` once its version is current.
    await trx
      .updateTable("works")
      .set({ status, hidden_cause: options.hiddenCause ?? null })
      .where("id", "=", work.id)
      .execute();
    return { ...seeded, ...version };
  });
}

/**
 * Adds a later version of a seeded work, from a new upload by the same user.
 * Its columns, byline and tags are the work's current ones, unless given. By
 * default it replaces the current one, and the work then describes it; with
 * `current: false` it is held (for `holdReason`, default `chapters_changed`),
 * and the work stays at the version it had.
 */
export async function seedVersion(
  db: Kysely<Database>,
  work: { workId: string; ao3WorkId: number; userId: string },
  options: SeedVersionOptions & { current?: boolean; holdReason?: HoldReason } = {},
): Promise<SeededVersion> {
  return inTransaction(db, async (trx) => {
    const columns = await currentColumns(trx, work.workId, options);
    return addVersion(trx, work, columns, { ...options, current: options.current ?? true });
  });
}

/** Puts each fragment in the bucket. Call it before reading the seeded work. */
export async function putFragments(bucket: FragmentBucket, fragments: Fragment[]): Promise<void> {
  await Promise.all(fragments.map((f) => bucket.put(f.key, f.body)));
}

/** Runs `fn` in the caller's transaction when it passed one, so a test can roll a seed back. */
async function inTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!db.isTransaction) return db.transaction().execute(fn);
  // SAFETY: Kysely sets isTransaction only on a Transaction instance.
  const trx = db as Transaction<Database>;
  return fn(trx);
}

type Planned = Required<SeedChapter>;

function planChapters(chapters: number | SeedChapter[] = 1): Planned[] {
  const list = Array.isArray(chapters) ? chapters : Array.from({ length: chapters }, () => ({}));
  // Ingest never writes a version without chapters.
  if (list.length === 0) throw new RangeError("seed: a version needs at least one chapter");
  return list.map((c: SeedChapter, i) => ({
    title: c.title ?? `Chapter ${i + 1}`,
    html: c.html ?? `<p>Seeded text of chapter ${i + 1}.</p>`,
    words: c.words ?? 1000,
  }));
}

async function addUser(trx: Transaction<Database>): Promise<string> {
  const id = `seed-${crypto.randomUUID()}`;
  await trx
    .insertInto("user")
    .values({ id, name: "Seed uploader", email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

/** A version's columns, byline and tags, as `addVersion` stores them. */
interface VersionColumns {
  title: string;
  summary_html: string | null;
  rating: string | null;
  language: string | null;
  complete: boolean;
  published_at: string | null;
  updated_at: string | null;
  authors: { pseud: string; user: string | null }[];
  tags: { type: TagType; name: string }[];
}

/** The byline the options give, in the version's terms, or undefined when they give none. */
function bylineOf(options: SeedVersionFields): VersionColumns["authors"] | undefined {
  if (options.anonymous) return [{ pseud: "Anonymous", user: null }];
  return options.authors?.map((a) => ({ pseud: a.pseud, user: a.ao3_user }));
}

/** A tag given twice keeps its first place. */
function uniqueTags(tags: { type: TagType; name: string }[]): VersionColumns["tags"] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = `${tag.type}\n${tag.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The tags with their rating tag replaced by `rating`'s, as ingest derives it from the file:
 * unchanged when `rating` is undefined.
 */
function withRating(
  tags: VersionColumns["tags"],
  rating: string | null | undefined,
): VersionColumns["tags"] {
  if (rating === undefined) return tags;
  const rest = tags.filter((t) => t.type !== "rating");
  return rating === null ? rest : [{ type: "rating", name: rating }, ...rest];
}

/** The work's current columns, byline and tags, with any the options give in their place. */
async function currentColumns(
  trx: Transaction<Database>,
  workId: string,
  options: SeedVersionFields,
): Promise<VersionColumns> {
  const work = await trx
    .selectFrom("works")
    .select([
      "title",
      "summary_html",
      "rating",
      "language",
      "complete",
      "published_at",
      "updated_at",
    ])
    .where("id", "=", workId)
    .executeTakeFirstOrThrow();
  const authors = await trx
    .selectFrom("work_authors")
    .select(["pseud", "ao3_user as user"])
    .where("work_id", "=", workId)
    .orderBy("position")
    .execute();
  const tags = await trx
    .selectFrom("work_tags")
    .innerJoin("tags", "tags.id", "work_tags.tag_id")
    .select(["tags.type", "tags.name"])
    .where("work_tags.work_id", "=", workId)
    .orderBy("work_tags.position")
    .execute();
  return {
    title: options.title ?? work.title,
    summary_html: options.summary === undefined ? work.summary_html : options.summary,
    rating: options.rating === undefined ? work.rating : options.rating,
    language: work.language,
    complete: options.complete ?? work.complete,
    published_at: work.published_at?.toISOString() ?? null,
    updated_at:
      options.updatedAt === undefined
        ? (work.updated_at?.toISOString() ?? null)
        : options.updatedAt,
    authors: bylineOf(options) ?? authors,
    tags: uniqueTags(options.tags ?? withRating(tags, options.rating)),
  };
}

async function addVersion(
  trx: Transaction<Database>,
  work: { workId: string; ao3WorkId: number; userId: string },
  columns: VersionColumns,
  options: SeedVersionOptions & { current: boolean; holdReason?: HoldReason },
): Promise<SeededVersion> {
  const { current, reviewReasons = [], chapterTotal = null, addedAt } = options;
  const chapters = planChapters(options.chapters);
  // Chosen here rather than by the database, because the R2 keys name it.
  const uploadId = crypto.randomUUID();
  const r2Prefix = `works/${work.ao3WorkId}/${uploadId}/`;
  await trx
    .insertInto("uploads")
    .values({
      id: uploadId,
      user_id: work.userId,
      r2_key: `uploads/${uploadId}.epub`,
      sha256: (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", ""),
      bytes: 1024,
      status: current ? "live" : "held_for_review",
      work_id: work.workId,
    })
    .execute();
  const { authors, tags, ...own } = columns;
  const version = await trx
    .insertInto("work_versions")
    .values({
      work_id: work.workId,
      upload_id: uploadId,
      chapter_count: chapters.length,
      chapter_total: chapterTotal,
      r2_prefix: r2Prefix,
      review_reasons: reviewReasons,
      created_at: addedAt,
      ...own,
      words: sum(chapters.map((c) => c.words)),
      raw_meta: "{}",
      hold_reason: current ? null : (options.holdReason ?? "chapters_changed"),
      tags: JSON.stringify(tags),
      authors: JSON.stringify(authors),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const keyed = chapters.map((c, i) => ({ ...c, n: i + 1, key: `${r2Prefix}${i + 1}.html` }));
  await trx
    .insertInto("chapters")
    .values(
      keyed.map((c) => ({
        work_id: work.workId,
        version_id: version.id,
        n: c.n,
        title: c.title,
        words: c.words,
        r2_key: c.key,
      })),
    )
    .execute();
  const fragments = keyed.map((c) => ({ key: c.key, body: c.html }));
  if (current) {
    // As ingest's replace does: the pointer, then the work describes the version, its byline,
    // tags and search text included.
    await trx
      .updateTable("works")
      .set({ current_version_id: version.id })
      .where("id", "=", work.workId)
      .execute();
    await copyVersionToWork(trx, work.workId, version.id);
  }
  return {
    uploadId,
    versionId: version.id,
    r2Prefix,
    chapterKeys: fragments.map((f) => f.key),
    fragments,
  };
}

function randomAo3WorkId(): number {
  return 1 + Math.floor(Math.random() * 2_000_000_000);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
