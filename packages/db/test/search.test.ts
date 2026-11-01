import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../migrations/index";
import { searchLiveWorks } from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

const ids = async (query: string, options?: { pageSize?: number; offset?: number }) =>
  (await searchLiveWorks(t.db, query, options)).works.map((w) => w.work.ao3_work_id);

describe("Metadata search", () => {
  let w1: number;
  let w2: number;
  let w3: number;
  beforeAll(async () => {
    w1 = (
      await seedWork(t.db, {
        title: "The Lighthouse Keeper",
        authors: [
          { pseud: "saltwater", ao3_user: "saltwater" },
          { pseud: "driftwood", ao3_user: null },
        ],
        tags: [
          { type: "freeform", name: "Found Family" },
          { type: "warning", name: "Creator Chose Not To Use Archive Warnings" },
        ],
        summary: "<p>A <em>storm</em> rolls in.</p>",
      })
    ).ao3WorkId;
    w2 = (
      await seedWork(t.db, {
        title: "Quiet Harbour",
        chapters: [{ title: "zeppelin" }],
        summary: "<p>Nothing here.</p>",
      })
    ).ao3WorkId;
    w3 = (
      await seedWork(t.db, {
        title: "Lighthouse Nights",
        status: "hidden",
        hiddenCause: "reports",
      })
    ).ao3WorkId;
  });

  it("Search by title", async () => {
    expect(await ids("lighthouse keeper")).toContain(w1);
  });

  it("Search by author", async () => {
    expect(await ids("saltwater")).toContain(w1);
    // Every author on the byline is indexed.
    expect(await ids("driftwood")).toContain(w1);
  });

  it("Search by tag", async () => {
    expect(await ids("found family")).toContain(w1);
    // Every tag type is indexed.
    expect(await ids("creator chose not")).toContain(w1);
  });

  it("Search by summary", async () => {
    // The word sits inside markup: tags are stripped before indexing.
    expect(await ids("storm")).toContain(w1);
    expect(await ids("em")).not.toContain(w1);
  });

  it("Fuzzy matching tolerates typos", async () => {
    expect(await ids("lighthose keeper")).toContain(w1);
    // The full-text path alone finds nothing for the typo, so this is the trigram path.
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from works
      where search @@ websearch_to_tsquery('simple', 'lighthose keeper')`.execute(t.db);
    expect(rows[0]?.n).toBe("0");
  });

  it("Chapter text is not searched", async () => {
    expect(await ids("zeppelin")).not.toContain(w2);
  });

  it("Hidden works are left out of results", async () => {
    const found = await ids("lighthouse");
    expect(found).toContain(w1);
    expect(found).not.toContain(w3);
  });

  it("leaves out removed and processing works too", async () => {
    const removed = await seedWork(t.db, { title: "Lighthouse Removed", status: "removed" });
    expect(await ids("lighthouse")).not.toContain(removed.ao3WorkId);
    await sql`update works set status = 'processing' where id = ${removed.workId}`.execute(t.db);
    expect(await ids("lighthouse")).not.toContain(removed.ao3WorkId);
  });

  it("returns each work with its byline and tags", async () => {
    const { works } = await searchLiveWorks(t.db, "lighthouse keeper");
    const found = works.find((w) => w.work.ao3_work_id === w1);
    expect(found?.authors.map((a) => a.pseud)).toEqual(["saltwater", "driftwood"]);
    expect(found?.tags.map((x) => x.name)).toEqual([
      "Found Family",
      "Creator Chose Not To Use Archive Warnings",
    ]);
  });
});

describe("search paging and ranking", () => {
  const marker = "quillfeather";
  let seeded: number[];
  beforeAll(async () => {
    seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push((await seedWork(t.db, { title: `${marker} ${i}` })).ao3WorkId);
    }
  });

  it("counts every match and pages without repeating or skipping", async () => {
    const all = await searchLiveWorks(t.db, marker);
    expect(all.total).toBe(5);
    expect(all.works).toHaveLength(5);
    const first = await searchLiveWorks(t.db, marker, { pageSize: 2, offset: 0 });
    const second = await searchLiveWorks(t.db, marker, { pageSize: 2, offset: 2 });
    const third = await searchLiveWorks(t.db, marker, { pageSize: 2, offset: 4 });
    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    const paged = [...first.works, ...second.works, ...third.works].map((w) => w.work.ao3_work_id);
    expect(paged).toEqual(all.works.map((w) => w.work.ao3_work_id));
    expect(new Set(paged)).toEqual(new Set(seeded));
    // Equal ranks break on the AO3 work ID.
    expect(paged).toEqual([...paged].sort((a, b) => a - b));
  });

  it("takes a page size or offset that is not usable as the default", async () => {
    expect((await searchLiveWorks(t.db, marker, { pageSize: 0 })).works).toHaveLength(5);
    expect((await searchLiveWorks(t.db, marker, { pageSize: 1.5 })).works).toHaveLength(5);
    expect((await searchLiveWorks(t.db, marker, { offset: -3 })).works).toHaveLength(5);
    expect((await searchLiveWorks(t.db, marker, { offset: 99 })).works).toEqual([]);
  });

  it("ranks a title match above a summary-only match", async () => {
    const inTitle = await seedWork(t.db, { title: "Zinnia Garden", summary: null });
    const inSummary = await seedWork(t.db, {
      title: "Something Else",
      summary: "<p>Zinnia zinnia zinnia</p>",
    });
    const found = await ids("zinnia");
    expect(found).toContain(inSummary.ao3WorkId);
    expect(found.indexOf(inTitle.ao3WorkId)).toBeLessThan(found.indexOf(inSummary.ao3WorkId));
  });
});

describe("search operators and limits", () => {
  const word = "heronpool";
  let both: number;
  let only: number;
  beforeAll(async () => {
    both = (await seedWork(t.db, { title: `${word} lantern` })).ao3WorkId;
    only = (await seedWork(t.db, { title: `${word} marsh` })).ao3WorkId;
  });

  it("keeps a word the reader excluded out, the trigram path included", async () => {
    const found = await ids(`${word} -lantern`);
    expect(found).toContain(only);
    expect(found).not.toContain(both);
  });

  it("finds nothing for a query of exclusions alone", async () => {
    expect(await searchLiveWorks(t.db, "-lantern -marsh")).toEqual({ works: [], total: 0 });
  });

  it("caps the page size", async () => {
    const r = await searchLiveWorks(t.db, word, { pageSize: 70_000 });
    expect(r.works.length).toBe(2);
    expect(r.total).toBe(2);
  });

  it("indexes a very long summary without failing the save", async () => {
    const long = Array.from({ length: 150_000 }, (_, i) => `w${i}`).join(" ");
    const w = await seedWork(t.db, { title: "Long Summary Cove", summary: `<p>${long}</p>` });
    expect(await ids("long summary cove")).toContain(w.ao3WorkId);
  });
});

describe("search of hostile input", () => {
  it("returns nothing for a blank query", async () => {
    for (const q of ["", "   ", "\n\t"]) {
      expect(await searchLiveWorks(t.db, q)).toEqual({ works: [], total: 0 });
    }
  });

  it("never throws on punctuation, a NUL byte or a very long query", async () => {
    const queries = [
      "a & ( b",
      "'",
      "!",
      "\\",
      "a | b <-> c",
      ":*",
      "lighthouse\0keeper",
      "x".repeat(10_000),
      "lighthouse ".repeat(2000),
    ];
    for (const q of queries) {
      const r = await searchLiveWorks(t.db, q);
      expect(Array.isArray(r.works)).toBe(true);
    }
  });
});

describe("search backfill", () => {
  it("indexes works that exist before migration 0008", async () => {
    const old = await createTestDb({ migrate: false });
    try {
      const at = migrations.findIndex((m) => m.name === "0008_search");
      expect(at).toBeGreaterThan(0);
      // Raw SQL, as that day's code knew the schema: there is no search_text yet.
      for (const m of migrations.slice(0, at)) await sql.raw(m.sql).execute(old.db);
      await sql`insert into "user" (id, name, email, email_verified)
        values ('u1', 'U', 'u1@example.test', true)`.execute(old.db);
      await sql`insert into works (id, ao3_work_id, title, summary_html, chapters_count, complete)
        values ('w1', 4242, 'Backfilled Beacon', '<p>Gulls <b>wheel</b></p>', 1, true)`.execute(
        old.db,
      );
      await sql`insert into uploads (id, user_id, r2_key, bytes, status, work_id)
        values ('up1', 'u1', 'uploads/up1.epub', 1, 'live', 'w1')`.execute(old.db);
      await sql`insert into work_versions (id, work_id, upload_id, chapter_count, r2_prefix)
        values ('v1', 'w1', 'up1', 1, 'works/4242/up1/')`.execute(old.db);
      await sql`insert into work_authors (work_id, pseud, position) values ('w1', 'tidewrack', 0)`.execute(
        old.db,
      );
      await sql`insert into tags (id, type, name, name_norm)
        values ('t1', 'freeform', 'Slow Burn', 'slow burn')`.execute(old.db);
      await sql`insert into work_tags (work_id, tag_id, position)
        values ('w1', 't1', 0)`.execute(old.db);
      await sql`update works set current_version_id = 'v1', status = 'live'
        where id = 'w1'`.execute(old.db);
      await sql.raw(migrations[at]!.sql).execute(old.db);
      for (const q of ["backfilled beacon", "tidewrack", "slow burn", "wheel", "backfilld"]) {
        const r = await searchLiveWorks(old.db, q);
        expect(
          r.works.map((x) => x.work.ao3_work_id),
          q,
        ).toEqual([4242]);
      }
    } finally {
      await old.close();
    }
  });
});
