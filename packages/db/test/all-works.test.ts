import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listLiveWorks } from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

// This file's own database, so a listing of every work holds only what it seeds.
let t: TestDb;
const live: { workId: string; ao3WorkId: number }[] = [];
beforeAll(async () => {
  t = await createTestDb();
  // 23 live works across two fandoms, one updated each day of January.
  for (let i = 0; i < 23; i++) {
    live.push(
      await seedWork(t.db, {
        ao3WorkId: 36000 + i,
        updatedAt: `2021-01-${String(i + 1).padStart(2, "0")}`,
        rating: i % 2 === 0 ? "Explicit" : "General Audiences",
        complete: i % 3 === 0,
        tags: [{ type: "fandom", name: i % 2 === 0 ? "All Works A" : "All Works B" }],
      }),
    );
  }
  await seedWork(t.db, {
    ao3WorkId: 36100,
    status: "hidden",
    hiddenCause: "reports",
  });
  await seedWork(t.db, { ao3WorkId: 36101, status: "removed" });
  // The seed makes only live, hidden and removed works; the others are set as ingest leaves them.
  for (const [ao3WorkId, status] of [
    [36102, "held"],
    [36103, "processing"],
  ] as const) {
    const { workId } = await seedWork(t.db, { ao3WorkId });
    await t.db.updateTable("works").set({ status }).where("id", "=", workId).execute();
  }
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

describe("14 browse and home: all works", () => {
  it("All works lists every live work, a page at a time", async () => {
    const first = await listLiveWorks(t.db, { page: 1, pageSize: 20 });
    const second = await listLiveWorks(t.db, { page: 2, pageSize: 20 });

    expect(first.total).toBe(23);
    expect(first.works).toHaveLength(20);
    const seen = [...first.works, ...second.works].map((w) => w.work.ao3_work_id);
    expect(new Set(seen).size).toBe(23);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      live.map((w) => w.ao3WorkId).sort((a, b) => a - b),
    );
    // Updated date by default, newest first.
    expect(seen[0]).toBe(36022);
    expect(seen[22]).toBe(36000);
  });

  it("All works leaves out every work that isn't live", async () => {
    const { works, total } = await listLiveWorks(t.db, { pageSize: 100 });

    expect(total).toBe(23);
    const ids = works.map((w) => w.work.ao3_work_id);
    for (const id of [36100, 36101, 36102, 36103]) expect(ids).not.toContain(id);
  });

  it("All works sorts and filters like a tag listing", async () => {
    const explicit = await listLiveWorks(t.db, {
      rating: "Explicit",
      pageSize: 100,
    });
    expect(explicit.total).toBe(12);

    const complete = await listLiveWorks(t.db, {
      complete: true,
      pageSize: 100,
    });
    expect(complete.total).toBe(8);

    const narrowed = await listLiveWorks(t.db, {
      tag: { type: "fandom", name: "all works b" },
      pageSize: 100,
    });
    expect(narrowed.total).toBe(11);
    expect(narrowed.works.every((w) => w.work.ao3_work_id % 2 === 1)).toBe(true);

    const nothing = await listLiveWorks(t.db, {
      tag: { type: "fandom", name: "!!!" },
    });
    expect(nothing).toEqual({ works: [], total: 0 });
  });
});
