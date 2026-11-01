import { seedWork } from "@archive/db/seed";
import { createTestDb, type TestDb } from "@archive/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweep, type ListedObject, type SweepBucket } from "../src/sweep";

// The sweep over a bucket that pages two entries at a time, as R2 may: every listing the sweep
// makes (folders, a folder's prefixes, a prefix's objects, the images) spans several pages, which
// local R2 would need a thousand objects for. The workerd tests cover the handler and real R2.

const IMG = (n: number) => n.toString(16).padStart(64, "0");
const OLD = new Date(0);

/**
 * An in-memory bucket with R2's listing rules, two entries a page; `deletes` records each call.
 * `onGet` runs before each `get`, with the store, to fail it or to change the bucket meanwhile.
 */
function pagingBucket(
  keys: Record<string, string>,
  onGet: (key: string, store: Map<string, string>) => Promise<void> = async () => {},
) {
  const store = new Map(Object.entries(keys));
  const deletes: string[][] = [];
  const bucket: SweepBucket = {
    async list({ prefix, delimiter, cursor, startAfter }) {
      const from = cursor ?? startAfter ?? "";
      const objects: ListedObject[] = [];
      const prefixes: string[] = [];
      let last = from;
      let truncated = false;
      for (const key of [...store.keys()].sort()) {
        if (key <= from || !key.startsWith(prefix)) continue;
        const cut = delimiter === undefined ? -1 : key.indexOf(delimiter, prefix.length);
        const rolled = cut === -1 ? null : key.slice(0, cut + 1);
        if (rolled !== null && prefixes.includes(rolled)) {
          last = key;
          continue;
        }
        if (objects.length + prefixes.length === 2) {
          truncated = true;
          break;
        }
        if (rolled === null) objects.push({ key, uploaded: OLD });
        else prefixes.push(rolled);
        last = key;
      }
      return {
        objects,
        delimitedPrefixes: prefixes,
        truncated,
        cursor: truncated ? last : undefined,
      };
    },
    async get(key) {
      await onGet(key, store);
      const body = store.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    async delete(keys) {
      deletes.push(keys);
      for (const key of keys) store.delete(key);
    },
  };
  return { bucket, deletes, keys: () => [...store.keys()].sort() };
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});
beforeEach(async () => {
  await t.db.updateTable("sweep_state").set({ after: null }).execute();
});

const LIMITS = { works: 100, subrequests: 10_000 };
const refused = "11111111-1111-4111-8111-111111111111";
const duplicate = "22222222-2222-4222-8222-222222222222";

describe("sweep paging", () => {
  it("Every page of every listing is swept, and deletes go 1000 keys at most", async () => {
    const live = await seedWork(t.db, {
      ao3WorkId: 1_000_001,
      summary: `<img src="/works/1000001/img/${IMG(1)}">`,
      chapters: [
        { html: `<img src="/works/1000001/img/${IMG(2)}">` },
        { html: `<img src="/works/1000001/img/${IMG(3)}">` },
        { html: "<p>No image.</p>" },
      ],
    });
    const files: Record<string, string> = Object.fromEntries(
      live.fragments.map((f) => [f.key, f.body]),
    );
    for (let n = 1; n <= 6; n++) files[`works/1000001/img/${IMG(n)}`] = "";
    for (let n = 1; n <= 1001; n++) files[`works/1000001/${refused}/${n}.html`] = "";
    files[`works/1000001/${duplicate}/1.html`] = "";
    // Two folders with no work: everything in them goes.
    files[`works/1000002/${refused}/1.html`] = "";
    files[`works/1000003/img/${IMG(9)}`] = "";
    const { bucket, deletes, keys } = pagingBucket(files);

    const report = await sweep({ db: t.db, bucket, cutoff: new Date(), limits: LIMITS });

    expect(keys()).toEqual(
      [...live.chapterKeys, ...[1, 2, 3].map((n) => `works/1000001/img/${IMG(n)}`)].sort(),
    );
    expect(report).toMatchObject({ works: 3, finished: true, imagesDeleted: 4 });
    expect(report.prefixesDeleted).toBe(3);
    expect(Math.max(...deletes.map((d) => d.length))).toBe(1000);
  });

  it("A run bounded to one work goes on from the next folder each time", async () => {
    const files: Record<string, string> = {};
    for (const id of [2_000_001, 2_000_002, 2_000_003]) files[`works/${id}/img/${IMG(1)}`] = "";
    const { bucket, keys } = pagingBucket(files);
    const run = () =>
      sweep({ db: t.db, bucket, cutoff: new Date(), limits: { ...LIMITS, works: 1 } });

    expect((await run()).finished).toBe(false);
    expect(keys()).toEqual([`works/2000002/img/${IMG(1)}`, `works/2000003/img/${IMG(1)}`]);
    await run();
    expect(keys()).toEqual([`works/2000003/img/${IMG(1)}`]);
    await run();
    expect(keys()).toEqual([]);
  });
});

describe("sweep safety", () => {
  it("An upload that starts during the reference scan keeps the work's images", async () => {
    const live = await seedWork(t.db, { ao3WorkId: 3_000_001 });
    const files: Record<string, string> = Object.fromEntries(
      live.fragments.map((f) => [f.key, f.body]),
    );
    files[`works/3000001/img/${IMG(5)}`] = "";
    const late = "33333333-3333-4333-8333-333333333333";
    const { bucket, keys } = pagingBucket(files, async (_key, store) => {
      if (store.has(`works/3000001/${late}/1.html`)) return;
      // A job claims its upload and writes its first fragment while the sweep reads.
      await t.db
        .insertInto("uploads")
        .values({
          id: late,
          user_id: live.userId,
          r2_key: `uploads/${late}.epub`,
          bytes: 1,
          status: "processing",
        })
        .execute();
      store.set(`works/3000001/${late}/1.html`, "");
    });

    const report = await sweep({ db: t.db, bucket, cutoff: new Date(), limits: LIMITS });

    expect(keys()).toContain(`works/3000001/img/${IMG(5)}`);
    expect(report.skipped).toEqual([{ ao3WorkId: 3_000_001, reason: "changed" }]);
  });

  it("A work that fails is passed over, and a run ends after three", async () => {
    class StorageDown extends Error {}
    const failing = [4_000_001, 4_000_002, 4_000_003];
    const files: Record<string, string> = {};
    for (const ao3WorkId of failing) {
      const work = await seedWork(t.db, { ao3WorkId });
      for (const f of work.fragments) files[f.key] = f.body;
      files[`works/${ao3WorkId}/img/${IMG(1)}`] = "";
    }
    files[`works/4000004/img/${IMG(1)}`] = "";
    const { bucket, keys } = pagingBucket(files, async (key) => {
      if (/^works\/400000[123]\//.test(key)) throw new StorageDown();
    });

    const first = await sweep({ db: t.db, bucket, cutoff: new Date(), limits: LIMITS });
    expect(first.finished).toBe(false);
    expect(first.skipped).toEqual(
      failing.map((ao3WorkId) => ({ ao3WorkId, reason: "error", error: "StorageDown" })),
    );
    expect(keys()).toContain(`works/4000004/img/${IMG(1)}`);

    // The next run starts past them.
    await sweep({ db: t.db, bucket, cutoff: new Date(), limits: LIMITS });
    expect(keys()).not.toContain(`works/4000004/img/${IMG(1)}`);
    for (const ao3WorkId of failing) expect(keys()).toContain(`works/${ao3WorkId}/img/${IMG(1)}`);
  });

  it("A folder not named as ingest names one is left alone", async () => {
    const { bucket, keys } = pagingBucket({
      [`works/0123/img/${IMG(1)}`]: "",
      [`works/123/img/${IMG(1)}`]: "",
      [`works/x/img/${IMG(1)}`]: "",
      [`works/123/not-an-upload/1.html`]: "",
    });

    await sweep({ db: t.db, bucket, cutoff: new Date(), limits: LIMITS });

    expect(keys()).toEqual([
      `works/0123/img/${IMG(1)}`,
      `works/123/not-an-upload/1.html`,
      `works/x/img/${IMG(1)}`,
    ]);
  });
});
