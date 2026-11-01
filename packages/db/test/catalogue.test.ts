import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HiddenCause, TagType, UploadStatus, WorkStatus } from "../src/index";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

// Expected columns: ARCHITECTURE's Data model for the catalogue and uploads,
// plus `work_tags.position` (the author's order of a work's tags).
const expected = {
  works: {
    id: { type: "text", nullable: false },
    ao3_work_id: { type: "int4", nullable: false },
    title: { type: "text", nullable: false },
    summary_html: { type: "text", nullable: true },
    rating: { type: "text", nullable: true },
    language: { type: "text", nullable: true },
    words: { type: "int4", nullable: true },
    chapters_count: { type: "int4", nullable: false },
    chapters_total: { type: "int4", nullable: true },
    complete: { type: "bool", nullable: false },
    published_at: { type: "timestamptz", nullable: true },
    updated_at: { type: "timestamptz", nullable: true },
    status: { type: "text", nullable: false },
    hidden_cause: { type: "text", nullable: true },
    current_version_id: { type: "text", nullable: true },
    raw_meta: { type: "jsonb", nullable: false },
    search: { type: "tsvector", nullable: true },
    search_text: { type: "text", nullable: true },
  },
  work_authors: {
    work_id: { type: "text", nullable: false },
    pseud: { type: "text", nullable: false },
    ao3_user: { type: "text", nullable: true },
    position: { type: "int4", nullable: false },
  },
  work_versions: {
    id: { type: "text", nullable: false },
    work_id: { type: "text", nullable: false },
    upload_id: { type: "text", nullable: false },
    chapter_count: { type: "int4", nullable: false },
    chapter_total: { type: "int4", nullable: true },
    r2_prefix: { type: "text", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
    review_reasons: { type: "_text", nullable: false },
    checked_at: { type: "timestamptz", nullable: true },
    tags: { type: "jsonb", nullable: true },
    authors: { type: "jsonb", nullable: true },
    title: { type: "text", nullable: true },
    summary_html: { type: "text", nullable: true },
    rating: { type: "text", nullable: true },
    language: { type: "text", nullable: true },
    words: { type: "int4", nullable: true },
    complete: { type: "bool", nullable: true },
    published_at: { type: "timestamptz", nullable: true },
    updated_at: { type: "timestamptz", nullable: true },
    raw_meta: { type: "jsonb", nullable: true },
    hold_reason: { type: "text", nullable: true },
  },
  chapters: {
    work_id: { type: "text", nullable: false },
    version_id: { type: "text", nullable: false },
    n: { type: "int4", nullable: false },
    title: { type: "text", nullable: false },
    words: { type: "int4", nullable: false },
    r2_key: { type: "text", nullable: false },
  },
  tags: {
    id: { type: "text", nullable: false },
    type: { type: "text", nullable: false },
    name: { type: "text", nullable: false },
    name_norm: { type: "text", nullable: false },
  },
  work_tags: {
    work_id: { type: "text", nullable: false },
    tag_id: { type: "text", nullable: false },
    position: { type: "int4", nullable: false },
  },
  uploads: {
    id: { type: "text", nullable: false },
    user_id: { type: "text", nullable: false },
    r2_key: { type: "text", nullable: false },
    sha256: { type: "text", nullable: true },
    bytes: { type: "int4", nullable: false },
    status: { type: "text", nullable: false },
    lease_until: { type: "timestamptz", nullable: true },
    quota_counted_at: { type: "timestamptz", nullable: true },
    error_stage: { type: "text", nullable: true },
    error: { type: "text", nullable: true },
    work_id: { type: "text", nullable: true },
    created_at: { type: "timestamptz", nullable: false },
  },
} satisfies Record<string, Record<string, { type: string; nullable: boolean }>>;

describe("packages/db catalogue and uploads", () => {
  it("The catalogue and uploads tables have the Data model's columns", async () => {
    const tables = await t.db.introspection.getTables();
    for (const [table, columns] of Object.entries(expected)) {
      const found = tables.find((x) => x.name === table);
      expect(found, `table ${table}`).toBeDefined();
      const actual = Object.fromEntries(
        found!.columns.map((c) => [c.name, { type: c.dataType, nullable: c.isNullable }]),
      );
      expect(actual, `columns of ${table}`).toEqual(columns);
    }
  });

  it("Ids the insert leaves out are filled in", async () => {
    const { id } = await addWork(100);
    expect(id).toHaveLength(36);
  });

  it("A new upload is pending, with no hash yet", async () => {
    await addUser("pending-uploader");
    const row = await t.db
      .insertInto("uploads")
      .values({ user_id: "pending-uploader", r2_key: "uploads/x.epub", bytes: 10 })
      .returning(["status", "sha256", "lease_until", "work_id"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "pending", sha256: null, lease_until: null, work_id: null });
  });
});

let users = 0;
async function addUser(id = `user-${++users}`) {
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

async function addWork(ao3WorkId: number) {
  return t.db
    .insertInto("works")
    .values({ ao3_work_id: ao3WorkId, title: "t", chapters_count: 1, complete: true })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function addVersion(workId: string, prefix = `works/${workId}/`) {
  const userId = await addUser();
  const upload = await t.db
    .insertInto("uploads")
    .values({ user_id: userId, r2_key: `uploads/${userId}.epub`, bytes: 1, work_id: workId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return t.db
    .insertInto("work_versions")
    .values({ work_id: workId, upload_id: upload.id, chapter_count: 1, r2_prefix: prefix })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function addTag(type: string, name: string) {
  // SAFETY: the constraint tests pass values the TagType union refuses, to reach the CHECK.
  const tagType = type as TagType;
  return t.db
    .insertInto("tags")
    .values({ type: tagType, name, name_norm: name.toLowerCase() })
    .returning("id")
    .executeTakeFirstOrThrow();
}

describe("packages/db catalogue constraints", () => {
  it("A second work with the same AO3 work ID is refused", async () => {
    await addWork(200);
    await expect(addWork(200)).rejects.toThrow(/unique/i);
  });

  it("A work status outside the Data model is refused", async () => {
    const { id } = await addWork(201);
    // SAFETY: "held" is outside WorkStatus on purpose: the CHECK must refuse it.
    const status = "held" as WorkStatus;
    await expect(
      t.db.updateTable("works").set({ status }).where("id", "=", id).execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("A hidden work needs a hidden cause, and only a hidden work has one", async () => {
    const { id } = await addWork(202);
    const version = await addVersion(id);
    await t.db
      .updateTable("works")
      .set({ current_version_id: version.id })
      .where("id", "=", id)
      .execute();
    const set = (status: WorkStatus, hidden_cause: HiddenCause | null) =>
      t.db.updateTable("works").set({ status, hidden_cause }).where("id", "=", id).execute();
    await expect(set("hidden", null)).rejects.toThrow(/check constraint/i);
    await expect(set("live", "reports")).rejects.toThrow(/check constraint/i);
    // SAFETY: an unknown cause is outside HiddenCause on purpose: the CHECK must refuse it.
    await expect(set("hidden", "bored" as HiddenCause)).rejects.toThrow(/check constraint/i);
    await set("hidden", "moderator");
  });

  it("An upload status outside the pipeline's is refused", async () => {
    const userId = await addUser();
    // SAFETY: "bogus" is outside UploadStatus on purpose: the CHECK must refuse it.
    const status = "bogus" as UploadStatus;
    await expect(
      t.db
        .insertInto("uploads")
        .values({ user_id: userId, r2_key: "k", bytes: 1, status })
        .execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("An upload for a user who doesn't exist is refused", async () => {
    await expect(
      t.db.insertInto("uploads").values({ user_id: "nobody", r2_key: "k", bytes: 1 }).execute(),
    ).rejects.toThrow(/foreign key/i);
  });

  it("A version for a work that doesn't exist is refused", async () => {
    await expect(addVersion("no-such-work")).rejects.toThrow(/foreign key/i);
  });

  it("A work's current version must be one of its own versions", async () => {
    const mine = await addWork(203);
    const other = await addWork(204);
    const theirs = await addVersion(other.id);
    await expect(
      t.db
        .updateTable("works")
        .set({ current_version_id: theirs.id })
        .where("id", "=", mine.id)
        .execute(),
    ).rejects.toThrow(/foreign key/i);
  });

  it("A chapter number appears once per version", async () => {
    const work = await addWork(205);
    const version = await addVersion(work.id);
    const chapter = { work_id: work.id, version_id: version.id, n: 1, title: "", words: 1 };
    await t.db
      .insertInto("chapters")
      .values({ ...chapter, r2_key: "a" })
      .execute();
    await expect(
      t.db
        .insertInto("chapters")
        .values({ ...chapter, r2_key: "b" })
        .execute(),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("A tag type outside the seven is refused", async () => {
    await expect(addTag("genre", "x")).rejects.toThrow(/check constraint/i);
  });

  it("A tag is one row per type and name as written", async () => {
    await addTag("fandom", "Same Name");
    await addTag("character", "Same Name");
    await addTag("fandom", "same name");
    await expect(addTag("fandom", "Same Name")).rejects.toThrow(/unique|duplicate key/i);
  });

  it("A work carries a tag once", async () => {
    const work = await addWork(206);
    const tag = await addTag("freeform", "Once");
    const link = { work_id: work.id, tag_id: tag.id };
    await t.db
      .insertInto("work_tags")
      .values({ ...link, position: 0 })
      .execute();
    await expect(
      t.db
        .insertInto("work_tags")
        .values({ ...link, position: 1 })
        .execute(),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("Only a work still processing may lack a current version", async () => {
    const { id } = await addWork(209);
    await expect(
      t.db.updateTable("works").set({ status: "live" }).where("id", "=", id).execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("A work lists a pseud once", async () => {
    const work = await addWork(210);
    const author = { work_id: work.id, pseud: "twice", ao3_user: null, position: 0 };
    await t.db.insertInto("work_authors").values(author).execute();
    await expect(
      t.db
        .insertInto("work_authors")
        .values({ ...author, position: 1 })
        .execute(),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("Co-authors may share a pseud name under different users", async () => {
    const work = await addWork(211);
    await t.db
      .insertInto("work_authors")
      .values([
        { work_id: work.id, pseud: "Sam", ao3_user: "alice", position: 0 },
        { work_id: work.id, pseud: "Sam", ao3_user: "bob", position: 1 },
      ])
      .execute();
    const anonymous = { work_id: work.id, pseud: "Anonymous", ao3_user: null, position: 2 };
    await t.db.insertInto("work_authors").values(anonymous).execute();
    await expect(
      t.db
        .insertInto("work_authors")
        .values({ ...anonymous, position: 3 })
        .execute(),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("A work's tags can be renumbered in one statement", async () => {
    const work = await addWork(212);
    const a = await addTag("freeform", "Renumber A");
    const b = await addTag("freeform", "Renumber B");
    await t.db
      .insertInto("work_tags")
      .values([
        { work_id: work.id, tag_id: a.id, position: 0 },
        { work_id: work.id, tag_id: b.id, position: 1 },
      ])
      .execute();
    await t.db
      .updateTable("work_tags")
      .set((eb) => ({ position: eb("position", "+", 1) }))
      .where("work_id", "=", work.id)
      .execute();
    const rows = await t.db
      .selectFrom("work_tags")
      .select("position")
      .where("work_id", "=", work.id)
      .orderBy("position")
      .execute();
    expect(rows).toEqual([{ position: 1 }, { position: 2 }]);
  });

  it("An upload's size can't be negative", async () => {
    const userId = await addUser();
    await expect(
      t.db.insertInto("uploads").values({ user_id: userId, r2_key: "k", bytes: -1 }).execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("Two of a work's tags can't share a position", async () => {
    const work = await addWork(208);
    const a = await addTag("freeform", "Position A");
    const b = await addTag("freeform", "Position B");
    await t.db
      .insertInto("work_tags")
      .values({ work_id: work.id, tag_id: a.id, position: 0 })
      .execute();
    await expect(
      t.db
        .insertInto("work_tags")
        .values({ work_id: work.id, tag_id: b.id, position: 0 })
        .execute(),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("Deleting a work deletes its authors, versions, chapters and tag links", async () => {
    const work = await addWork(207);
    const version = await addVersion(work.id);
    const tag = await addTag("freeform", "Kept tag");
    await t.db
      .updateTable("works")
      .set({ current_version_id: version.id })
      .where("id", "=", work.id)
      .execute();
    await t.db
      .insertInto("work_authors")
      .values({ work_id: work.id, pseud: "p", ao3_user: null, position: 0 })
      .execute();
    await t.db
      .insertInto("chapters")
      .values({ work_id: work.id, version_id: version.id, n: 1, title: "", words: 1, r2_key: "k" })
      .execute();
    await t.db
      .insertInto("work_tags")
      .values({ work_id: work.id, tag_id: tag.id, position: 0 })
      .execute();

    await t.db.deleteFrom("works").where("id", "=", work.id).execute();

    const left = await Promise.all(
      (["work_authors", "work_versions", "chapters", "work_tags"] as const).map((table) =>
        t.db.selectFrom(table).select("work_id").where("work_id", "=", work.id).execute(),
      ),
    );
    expect(left).toEqual([[], [], [], []]);
    const tags = await t.db.selectFrom("tags").select("id").where("id", "=", tag.id).execute();
    expect(tags).toEqual([{ id: tag.id }]);
  });
});
