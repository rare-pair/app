import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../migrations/index";
import { migrate } from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

const MIGRATION = "0012_version_work_columns";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

/** A database as it was deployed before this item: every earlier migration applied and recorded. */
async function createDeployedDb(): Promise<TestDb> {
  const deployed = await createTestDb({ migrate: false });
  try {
    await sql`create table schema_migrations (
      name text primary key,
      applied_at timestamptz not null default current_timestamp
    )`.execute(deployed.db);
    const at = migrations.findIndex((x) => x.name === MIGRATION);
    if (at < 0) throw new Error(`migration ${MIGRATION} is not registered`);
    for (const m of migrations.slice(0, at)) {
      await sql.raw(m.sql).execute(deployed.db);
      await sql`insert into schema_migrations (name) values (${m.name})`.execute(deployed.db);
    }
    return deployed;
  } catch (err) {
    await deployed.close();
    throw err;
  }
}

describe("packages/db per-version work columns", () => {
  it("The migration applies on top of the earlier ones, and a second run applies nothing", async () => {
    const deployed = await createDeployedDb();
    try {
      const first = await migrate(deployed.db);
      const second = await migrate(deployed.db);
      const fromHere = migrations.slice(migrations.findIndex((x) => x.name === MIGRATION));
      expect([first, second]).toEqual([fromHere.map((x) => x.name), []]);
    } finally {
      await deployed.close();
    }
  });

  it("Existing versions are backfilled: the current one from the work, others left NULL", async () => {
    const deployed = await createDeployedDb();
    try {
      const db = deployed.db;
      await sql`insert into "user" (id, name, email, email_verified)
        values ('u1', 'u', 'u1@example.test', true)`.execute(db);
      await sql`insert into works (id, ao3_work_id, title, summary_html, rating, language, words,
          chapters_count, chapters_total, complete, published_at, updated_at, status, raw_meta)
        values ('w1', 7101, 'Backfilled', '<p>s</p>', 'Teen And Up Audiences', 'English', 1200,
          2, 3, false, '2020-01-02T00:00:00Z', '2020-02-01T00:00:00Z', 'processing',
          '{"Series":"One"}')`.execute(db);
      await sql`insert into uploads (id, user_id, r2_key, bytes, status) values
        ('up-old', 'u1', 'uploads/up-old.epub', 1, 'live'),
        ('up-new', 'u1', 'uploads/up-new.epub', 1, 'live')`.execute(db);
      await sql`insert into work_versions (id, work_id, upload_id, chapter_count, r2_prefix) values
        ('v-old', 'w1', 'up-old', 1, 'works/7101/up-old/'),
        ('v-new', 'w1', 'up-new', 2, 'works/7101/up-new/')`.execute(db);
      await sql`update works set current_version_id = 'v-new', status = 'live'
        where id = 'w1'`.execute(db);
      await sql`insert into tags (id, type, name, name_norm) values
        ('t1', 'fandom', 'Backfill Fandom', 'backfill fandom'),
        ('t2', 'freeform', 'Backfill Tag', 'backfill tag')`.execute(db);
      await sql`insert into work_tags (work_id, tag_id, position) values
        ('w1', 't2', 1), ('w1', 't1', 0)`.execute(db);
      await sql`insert into work_authors (work_id, pseud, ao3_user, position) values
        ('w1', 'Second', null, 1), ('w1', 'First', 'first', 0)`.execute(db);

      await migrate(db);

      const rows = await db
        .selectFrom("work_versions")
        .select([
          "id",
          "title",
          "summary_html",
          "rating",
          "language",
          "words",
          "complete",
          "published_at",
          "updated_at",
          "raw_meta",
          "hold_reason",
          "tags",
          "authors",
        ])
        .orderBy("id")
        .execute();
      expect(rows).toEqual([
        {
          id: "v-new",
          title: "Backfilled",
          summary_html: "<p>s</p>",
          rating: "Teen And Up Audiences",
          language: "English",
          words: 1200,
          complete: false,
          published_at: new Date("2020-01-02T00:00:00Z"),
          updated_at: new Date("2020-02-01T00:00:00Z"),
          raw_meta: { Series: "One" },
          hold_reason: null,
          tags: [
            { type: "fandom", name: "Backfill Fandom" },
            { type: "freeform", name: "Backfill Tag" },
          ],
          authors: [
            { pseud: "First", user: "first" },
            { pseud: "Second", user: null },
          ],
        },
        {
          id: "v-old",
          title: null,
          summary_html: null,
          rating: null,
          language: null,
          words: null,
          complete: null,
          published_at: null,
          updated_at: null,
          raw_meta: null,
          hold_reason: null,
          tags: null,
          authors: null,
        },
      ]);
    } finally {
      await deployed.close();
    }
  });

  it("A current version's own tags and authors are kept by the backfill", async () => {
    const deployed = await createDeployedDb();
    try {
      const db = deployed.db;
      await sql`insert into "user" (id, name, email, email_verified)
        values ('u1', 'u', 'u1@example.test', true)`.execute(db);
      await sql`insert into works (id, ao3_work_id, title, chapters_count, complete)
        values ('w1', 7102, 't', 1, true)`.execute(db);
      await sql`insert into uploads (id, user_id, r2_key, bytes, status)
        values ('up', 'u1', 'uploads/up.epub', 1, 'live')`.execute(db);
      await sql`insert into work_versions (id, work_id, upload_id, chapter_count, r2_prefix, tags, authors)
        values ('v', 'w1', 'up', 1, 'works/7102/up/', '[]', '[{"pseud":"Own","user":null}]')`.execute(
        db,
      );
      await sql`update works set current_version_id = 'v', status = 'live' where id = 'w1'`.execute(
        db,
      );
      await sql`insert into work_authors (work_id, pseud, ao3_user, position)
        values ('w1', 'Other', null, 0)`.execute(db);

      await migrate(db);

      const row = await db
        .selectFrom("work_versions")
        .select(["title", "tags", "authors"])
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ title: "t", tags: [], authors: [{ pseud: "Own", user: null }] });
    } finally {
      await deployed.close();
    }
  });

  it("A version's hold reason is one of the three, or NULL", async () => {
    const s = await seedWork(t.db);
    for (const reason of ["chapters_changed", "tags_changed", "authors_changed", null] as const) {
      await t.db
        .updateTable("work_versions")
        .set({ hold_reason: reason })
        .where("id", "=", s.versionId)
        .execute();
    }
    await expect(
      sql`update work_versions set hold_reason = 'not_newer' where id = ${s.versionId}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});
