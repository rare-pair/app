import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getLiveWork,
  insertUpload,
  listLiveWorksByTag,
  listPopularFandoms,
  listRecentLiveWorks,
  liveTagSpellings,
  normalizeTagName,
} from "../src/index";
import { seedVersion, seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

describe("14 browse and home", () => {
  it("Tag matching uses the normalized form", async () => {
    const a = await seedWork(t.db, { tags: [{ type: "fandom", name: "Harry Potter" }] });
    const b = await seedWork(t.db, { tags: [{ type: "fandom", name: "harry  potter!" }] });
    await seedWork(t.db, { tags: [{ type: "fandom", name: "Harry Potter - J. K. Rowling" }] });
    await seedWork(t.db, {
      status: "hidden",
      hiddenCause: "reports",
      tags: [{ type: "fandom", name: "Harry Potter" }],
    });

    const { works } = await listLiveWorksByTag(t.db, "fandom", "Harry Potter");

    expect(works.map((w) => w.work.id).sort()).toEqual([a.workId, b.workId].sort());
    const names = await Promise.all(
      [a, b].map(async (s) => (await getLiveWork(t.db, s.ao3WorkId))?.tags[0]?.name),
    );
    expect(names).toEqual(["Harry Potter", "harry  potter!"]);
  });

  it("Tag listing shows paged works", async () => {
    const seeded: number[] = [];
    for (let i = 0; i < 45; i++) {
      const s = await seedWork(t.db, { tags: [{ type: "fandom", name: "Paged Db Fandom" }] });
      seeded.push(s.ao3WorkId);
    }
    await seedWork(t.db, {
      status: "hidden",
      hiddenCause: "reports",
      tags: [{ type: "fandom", name: "Paged Db Fandom" }],
    });
    const page = (n: number) =>
      listLiveWorksByTag(t.db, "fandom", "Paged Db Fandom", { page: n, pageSize: 20 });

    const pages = [await page(1), await page(2), await page(3)];

    expect(pages.map((p) => p.works.length)).toEqual([20, 20, 5]);
    expect(pages.map((p) => p.total)).toEqual([45, 45, 45]);
    // One updated date for all: AO3 work ID breaks the tie, so no work is on two pages or none.
    expect(pages.flatMap((p) => p.works.map((w) => w.work.ao3_work_id))).toEqual(
      seeded.sort((a, b) => a - b),
    );
    expect(await page(4)).toEqual({ works: [], total: 45 });
    // Below the first page, or not a whole number, is the first page, not a database error.
    for (const n of [0, -3, 1.5, 2.5, Number.NaN]) {
      expect(
        (await page(n)).works.map((w) => w.work.ao3_work_id),
        String(n),
      ).toEqual(seeded.slice(0, 20));
    }
    expect(await page(Number.MAX_SAFE_INTEGER)).toEqual({ works: [], total: 45 });
    // A page size that isn't a whole number above 0 is the default, 20.
    for (const pageSize of [0, -5, 2.5, Number.NaN]) {
      const listing = await listLiveWorksByTag(t.db, "fandom", "Paged Db Fandom", { pageSize });
      expect(listing.works, String(pageSize)).toHaveLength(20);
    }
  });

  it("Sort by updated date", async () => {
    const tags = [{ type: "fandom" as const, name: "Sorted Db Updated" }];
    const older = await seedWork(t.db, { tags, updatedAt: "2021-03-01T00:00:00Z" });
    const newest = await seedWork(t.db, { tags, updatedAt: "2023-05-01T00:00:00Z" });
    // Never updated: its published date, 2020-01-01, stands in.
    const never = await seedWork(t.db, { tags, updatedAt: null });
    const middle = await seedWork(t.db, { tags, updatedAt: "2022-01-01T00:00:00Z" });

    const sorted = await listLiveWorksByTag(t.db, "fandom", "Sorted Db Updated", {
      sort: "updated",
    });
    const byDefault = await listLiveWorksByTag(t.db, "fandom", "Sorted Db Updated");

    const expected = [newest, middle, older, never].map((s) => s.workId);
    expect(sorted.works.map((w) => w.work.id)).toEqual(expected);
    expect(byDefault.works.map((w) => w.work.id)).toEqual(expected);
  });

  it("Sort by word count", async () => {
    const tags = [{ type: "fandom" as const, name: "Sorted Db Words" }];
    const short = await seedWork(t.db, { tags, chapters: [{ words: 1200 }] });
    const long = await seedWork(t.db, { tags, chapters: [{ words: 4000 }, { words: 3000 }] });
    const middle = await seedWork(t.db, { tags, chapters: [{ words: 5000 }] });
    const tied = await seedWork(t.db, { tags, chapters: [{ words: 1200 }] });
    const noCount = await seedWork(t.db, { tags, chapters: [{ words: 900 }] });
    await t.db.updateTable("works").set({ words: null }).where("id", "=", noCount.workId).execute();

    const { works } = await listLiveWorksByTag(t.db, "fandom", "Sorted Db Words", {
      sort: "words",
    });

    // Equal counts by AO3 work ID; a work with no count last.
    const [first, second] = [short, tied].sort((a, b) => a.ao3WorkId - b.ao3WorkId);
    expect(works.map((w) => w.work.words)).toEqual([7000, 5000, 1200, 1200, null]);
    expect(works.map((w) => w.work.id)).toEqual(
      [long, middle, first, second, noCount].map((s) => s?.workId),
    );
  });

  it("Filter by rating", async () => {
    const tags = [{ type: "fandom" as const, name: "Filtered Db Rating" }];
    const explicit = await seedWork(t.db, { tags, rating: "Explicit" });
    await seedWork(t.db, { tags, rating: "Mature" });
    const unrated = await seedWork(t.db, { tags, rating: "Not Rated" });
    const none = await seedWork(t.db, { tags, rating: null });
    const blank = await seedWork(t.db, { tags, rating: "" });
    const list = (rating: string) =>
      listLiveWorksByTag(t.db, "fandom", "Filtered Db Rating", { rating });

    const onlyExplicit = await list("Explicit");
    // A card shows no rating as "Not Rated", so the filter finds those too.
    const notRated = await list("Not Rated");

    expect(onlyExplicit.works.map((w) => w.work.id)).toEqual([explicit.workId]);
    expect(onlyExplicit.total).toBe(1);
    expect(notRated.works.map((w) => w.work.id).sort()).toEqual(
      [unrated, none, blank].map((s) => s.workId).sort(),
    );
    expect(notRated.total).toBe(3);
  });

  it("Filter by tag and completion", async () => {
    const fandom = { type: "fandom" as const, name: "Filtered Db Narrow" };
    const both = await seedWork(t.db, {
      tags: [fandom, { type: "freeform", name: "Db Slow Burn" }],
      complete: true,
    });
    // Another spelling of the same tag.
    const spelled = await seedWork(t.db, {
      tags: [fandom, { type: "freeform", name: "db slow-burn!" }],
      complete: true,
    });
    const inProgress = await seedWork(t.db, {
      tags: [fandom, { type: "freeform", name: "Db Slow Burn" }],
      complete: false,
    });
    // The name as another type is another tag.
    await seedWork(t.db, {
      tags: [fandom, { type: "character", name: "Db Slow Burn" }],
      complete: true,
    });
    await seedWork(t.db, { tags: [fandom], complete: false });
    const list = (complete: boolean) =>
      listLiveWorksByTag(t.db, "fandom", "Filtered Db Narrow", {
        tag: { type: "freeform", name: "db slow burn" },
        complete,
      });

    const complete = await list(true);
    const unfinished = await list(false);

    expect(complete.works.map((w) => w.work.id).sort()).toEqual(
      [both, spelled].map((s) => s.workId).sort(),
    );
    expect(complete.total).toBe(2);
    expect(unfinished.works.map((w) => w.work.id)).toEqual([inProgress.workId]);
    // A narrowing tag that names nothing matches nothing.
    expect(
      await listLiveWorksByTag(t.db, "fandom", "Filtered Db Narrow", {
        tag: { type: "freeform", name: "!!!" },
      }),
    ).toEqual(NONE);
  });
});

const NONE = { works: [], total: 0 };

describe("packages/db tag listing", () => {
  it("A tag listing holds only tags of its own type", async () => {
    const fandom = await seedWork(t.db, { tags: [{ type: "fandom", name: "Listing Sherlock" }] });
    await seedWork(t.db, { tags: [{ type: "character", name: "Listing Sherlock" }] });

    const { works } = await listLiveWorksByTag(t.db, "fandom", "listing sherlock");

    expect(normalizeTagName("character", "Listing Sherlock")).toBe("listing sherlock");
    expect(works.map((w) => w.work.id)).toEqual([fandom.workId]);
  });

  it("A listed work carries its byline and tags in order", async () => {
    const s = await seedWork(t.db, {
      authors: [
        { pseud: "Zed", ao3_user: "zed" },
        { pseud: "Amy", ao3_user: null },
      ],
      tags: [
        { type: "relationship", name: "Listing B/C" },
        { type: "fandom", name: "Listing Byline" },
        { type: "character", name: "Listing A" },
      ],
    });
    const anon = await seedWork(t.db, {
      anonymous: true,
      tags: [{ type: "fandom", name: "Listing Byline" }],
    });

    const { works } = await listLiveWorksByTag(t.db, "fandom", "Listing Byline");

    const byId = [s, anon].sort((x, y) => x.ao3WorkId - y.ao3WorkId);
    expect(works.map((w) => w.work.id)).toEqual(byId.map((x) => x.workId));
    const mine = works.find((w) => w.work.id === s.workId);
    expect(mine?.authors).toEqual([
      { pseud: "Zed", ao3_user: "zed" },
      { pseud: "Amy", ao3_user: null },
    ]);
    expect(mine?.tags.map((x) => [x.type, x.name, x.name_norm])).toEqual([
      ["relationship", "Listing B/C", "listing b/c"],
      ["fandom", "Listing Byline", "listing byline"],
      ["character", "Listing A", "listing a"],
    ]);
    const anonymous = works.find((w) => w.work.id === anon.workId);
    expect(anonymous?.authors).toEqual([{ pseud: "Anonymous", ao3_user: null }]);
  });

  it("A listing by a stored name_norm finds its works, though the rule isn't idempotent", async () => {
    // Iota with a perispomeni: lowercasing after NFKC leaves a form a second NFKC composes.
    const name = "Ι͂ Listing";
    const s = await seedWork(t.db, { tags: [{ type: "fandom", name }] });
    const stored = normalizeTagName("fandom", name);
    expect(normalizeTagName("fandom", stored)).not.toBe(stored);

    const { works } = await listLiveWorksByTag(t.db, "fandom", stored);

    expect(works.map((w) => w.work.id)).toEqual([s.workId]);
  });

  it("A tag's spellings come from its live works only, by code unit", async () => {
    await seedWork(t.db, { tags: [{ type: "fandom", name: "db spelt  heading!" }] });
    await seedWork(t.db, { tags: [{ type: "fandom", name: "Db Spelt Heading" }] });
    await seedWork(t.db, { tags: [{ type: "fandom", name: "Db Spelt Heading" }] });
    await seedWork(t.db, {
      status: "hidden",
      hiddenCause: "reports",
      tags: [{ type: "fandom", name: "DB SPELT HEADING" }],
    });
    await seedWork(t.db, { tags: [{ type: "character", name: "Db Spelt Heading?" }] });

    expect(await liveTagSpellings(t.db, "fandom", "db spelt heading")).toEqual([
      "Db Spelt Heading",
      "db spelt  heading!",
    ]);
    expect(await liveTagSpellings(t.db, "fandom", "db never spelt")).toEqual([]);
    expect(await liveTagSpellings(t.db, "fandom", "!!!")).toEqual([]);
  });

  it("A name holding a NUL lists no works", async () => {
    expect(await listLiveWorksByTag(t.db, "fandom", "a\u0000b")).toEqual(NONE);
  });

  it("A name with nothing left once folded lists no works", async () => {
    await seedWork(t.db, { tags: [{ type: "freeform", name: "???" }] });
    expect(await listLiveWorksByTag(t.db, "freeform", "!!!")).toEqual(NONE);
    expect(await listLiveWorksByTag(t.db, "freeform", "")).toEqual(NONE);
  });
});

describe("packages/db uploads", () => {
  it("An inserted upload is pending, under the id the caller chose", async () => {
    const user = await seedWork(t.db);
    const id = crypto.randomUUID();

    const upload = await insertUpload(t.db, {
      id,
      userId: user.userId,
      r2Key: `uploads/${id}.epub`,
      bytes: 2048,
    });

    expect(upload).toEqual({ id, status: "pending" });
    const row = await t.db
      .selectFrom("uploads")
      .select(["user_id", "r2_key", "bytes", "status", "sha256"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      user_id: user.userId,
      r2_key: `uploads/${id}.epub`,
      bytes: 2048,
      status: "pending",
      sha256: null,
    });
  });
});

// Its own database, so the other tests' works don't share the fandoms and recent works.
describe("14 browse and home: the home page's lists", () => {
  let h: TestDb;
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(async () => {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
    await h?.close();
  });

  const fandom = (name: string) => [{ type: "fandom" as const, name }];

  it("Popular fandoms are ranked by their live works, one fandom per normalized name", async () => {
    for (const name of ["Harry Potter", "harry  potter!"]) {
      await seedWork(h.db, { tags: fandom(name) });
    }
    await seedWork(h.db, { tags: fandom("Harry Potter") });
    for (let i = 0; i < 2; i++) await seedWork(h.db, { tags: fandom("Sherlock") });
    await seedWork(h.db, { tags: fandom("Zelda") });
    await seedWork(h.db, { tags: fandom("Abba") });
    await seedWork(h.db, {
      status: "hidden",
      hiddenCause: "removal_request",
      tags: fandom("Only Gone"),
    });
    await seedWork(h.db, { status: "removed", tags: fandom("Only Gone") });

    const popular = await listPopularFandoms(h.db, 4);

    expect(popular.map((f) => [f.name, f.count])).toEqual([
      ["Harry Potter", 3],
      ["Sherlock", 2],
      ["Abba", 1],
      ["Zelda", 1],
    ]);
    expect(popular[0]?.name_norm).toBe(normalizeTagName("fandom", "Harry Potter"));
    expect((await listPopularFandoms(h.db)).map((f) => f.name)).not.toContain("Only Gone");
  });

  it("Popular fandoms are ten by default", async () => {
    for (let i = 0; i < 12; i++) await seedWork(h.db, { tags: fandom(`Cap Fandom ${i}`) });

    expect(await listPopularFandoms(h.db)).toHaveLength(10);
  });

  it("Recently added works are the live ones, by when their first version was added, newest first", async () => {
    const old = await seedWork(h.db, { addedAt: "2031-01-01T00:00:00Z" });
    const newest = await seedWork(h.db, { addedAt: "2031-03-01T00:00:00Z", updatedAt: null });
    const middle = await seedWork(h.db, { addedAt: "2031-02-01T00:00:00Z" });
    await seedWork(h.db, {
      addedAt: "2031-04-01T00:00:00Z",
      status: "hidden",
      hiddenCause: "removal_request",
    });
    await seedWork(h.db, { addedAt: "2031-05-01T00:00:00Z", status: "removed" });
    // A later version doesn't make the work newer.
    await seedVersion(h.db, old, { addedAt: "2031-06-01T00:00:00Z" });

    const recent = await listRecentLiveWorks(h.db, 3);

    expect(recent.map((w) => w.work.id)).toEqual([newest.workId, middle.workId, old.workId]);
    expect(recent[0]?.authors).toEqual([{ pseud: "Seed Author", ao3_user: "seed_author" }]);
    expect(recent[0]?.tags.map((t) => t.type)).toContain("fandom");
  });

  it("Recently added works are twelve by default", async () => {
    for (let i = 0; i < 14; i++) await seedWork(h.db, { addedAt: "2032-01-01T00:00:00Z" });

    expect(await listRecentLiveWorks(h.db)).toHaveLength(12);
  });
});
