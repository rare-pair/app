// Test-only helper, exported as `@archive/db/seed`: seeds works the way ingest
// leaves them. It loads in Node and in workerd alike, so it imports neither
// `pg` nor PGlite (nor `./index`, which pulls in `pg`): the caller passes its
// own Kysely. It writes no R2 object itself; `putFragments` does, in workerd,
// with the test's bucket binding. Text is synthetic: no fic text in tests.
// Default tags are shared rows: on a database several test files share, give
// each file its own tag names and AO3 work IDs, or a listing sees the others'.
import type { Kysely, Transaction } from "kysely";
import type { Database, HiddenCause, TagType } from "./schema";
import { compareTagKeys, normalizeTagName } from "./tags";

export interface SeedChapter {
  title?: string;
  /** The fragment, as the sanitizer would leave it. Notes go inline. */
  html?: string;
  words?: number;
}

export interface SeedVersionOptions {
  /** A count, or each chapter. Default 1. */
  chapters?: number | SeedChapter[];
  /** The planned total. Default null: unknown, and a current version replaces the work's total with it. */
  chapterTotal?: number | null;
  reviewReasons?: string[];
  /** When the version was created here. Default: now. */
  addedAt?: string;
}

export interface SeedWorkOptions extends SeedVersionOptions {
  /** Default: a random one, so test files sharing a database don't collide. */
  ao3WorkId?: number;
  title?: string;
  /** `summary_html`, as the sanitizer would leave it. Null for none. */
  summary?: string | null;
  rating?: string | null;
  complete?: boolean;
  /** AO3's last-updated date. Default 2020-02-01; null for none. */
  updatedAt?: string | null;
  /** The uploader. Default: a new user. */
  userId?: string;
  authors?: { pseud: string; ao3_user: string | null }[];
  /** One author, stored as ingest stores an anonymous byline. Overrides `authors`. */
  anonymous?: boolean;
  /** In the author's order. */
  tags?: { type: TagType; name: string }[];
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
  return inTransaction(db, async (trx) => {
    const userId = options.userId ?? (await addUser(trx));
    const work = await trx
      .insertInto("works")
      .values({
        ao3_work_id: ao3WorkId,
        title: options.title ?? `Seeded work ${ao3WorkId}`,
        summary_html: options.summary === undefined ? "<p>A seeded summary.</p>" : options.summary,
        rating,
        language: "English",
        published_at: "2020-01-01T00:00:00Z",
        updated_at: options.updatedAt === undefined ? "2020-02-01T00:00:00Z" : options.updatedAt,
        // The version below sets the counts as it becomes current.
        chapters_count: 0,
        complete: options.complete ?? true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const authors = options.anonymous
      ? [{ pseud: "Anonymous", ao3_user: null }]
      : (options.authors ?? [{ pseud: "Seed Author", ao3_user: "seed_author" }]);
    if (authors.length > 0) {
      await trx
        .insertInto("work_authors")
        .values(authors.map((a, position) => ({ work_id: work.id, ...a, position })))
        .execute();
    }
    await addTags(trx, work.id, tags);
    const seeded = { workId: work.id, ao3WorkId, userId };
    const version = await addVersion(trx, seeded, { ...options, current: true });
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
 * By default it replaces the current one; with `current: false` it is held,
 * and the work stays at the version it had.
 */
export async function seedVersion(
  db: Kysely<Database>,
  work: { workId: string; ao3WorkId: number; userId: string },
  options: SeedVersionOptions & { current?: boolean } = {},
): Promise<SeededVersion> {
  return inTransaction(db, (trx) =>
    addVersion(trx, work, { ...options, current: options.current ?? true }),
  );
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

async function addTags(
  trx: Transaction<Database>,
  workId: string,
  tags: { type: TagType; name: string }[],
): Promise<void> {
  // A tag given twice keeps its first place.
  const seen = new Set<string>();
  const unique = tags.filter((tag) => {
    const key = `${tag.type}\n${tag.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Upserted in the shared lock order (`compareTagKeys`). One row per type and
  // name: a second seed of the same tag reuses it, with `name_norm` brought up
  // to the rule.
  const byKey = unique.map((tag, position) => ({ ...tag, position })).sort(compareTagKeys);
  for (const tag of byKey) {
    const row = await trx
      .insertInto("tags")
      .values({ type: tag.type, name: tag.name, name_norm: normalizeTagName(tag.type, tag.name) })
      .onConflict((oc) =>
        oc
          .columns(["type", "name"])
          .doUpdateSet((eb) => ({ name_norm: eb.ref("excluded.name_norm") })),
      )
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("work_tags")
      .values({ work_id: workId, tag_id: row.id, position: tag.position })
      .execute();
  }
}

async function addVersion(
  trx: Transaction<Database>,
  work: { workId: string; ao3WorkId: number; userId: string },
  options: SeedVersionOptions & { current: boolean },
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
    await trx
      .updateTable("works")
      .set({
        current_version_id: version.id,
        chapters_count: chapters.length,
        chapters_total: chapterTotal,
        words: sum(chapters.map((c) => c.words)),
      })
      .where("id", "=", work.workId)
      .execute();
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
