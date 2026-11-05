import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bucketKeys,
  emptyBucket,
  freshAo3WorkId,
  imageKey,
  putImages,
  putPrefix,
  resetSweepState,
  runSweep,
  seededVersion,
  seededWork,
  upload,
  withDb,
  withImages,
} from "./helpers";
import { sweepWorker } from "../src/worker";

// Every sweep test is in this file, so they run one after another: the sweep's state row is
// shared by the whole database, and the local bucket by every test. Each test starts the
// sweep from the first folder, on an empty bucket.
beforeEach(async () => {
  await resetSweepState();
  await emptyBucket();
});

describe("07-sanitizing-and-images", () => {
  it("Unreferenced images are removed by the periodic sweep", async () => {
    const ao3WorkId = freshAo3WorkId();
    const [inChapter1, inChapter2, inSummary, unreferenced] = [
      imageKey(),
      imageKey(),
      imageKey(),
      imageKey(),
    ];
    await seededWork({
      ao3WorkId,
      summary: `<p>Summary.</p>${withImages(ao3WorkId, inSummary)}`,
      chapters: [
        { html: withImages(ao3WorkId, inChapter1) },
        { html: withImages(ao3WorkId, inChapter2) },
      ],
    });
    await putImages(ao3WorkId, inChapter1, inChapter2, inSummary, unreferenced);

    await runSweep(25);

    const img = `works/${ao3WorkId}/img/`;
    expect(await bucketKeys(img)).toEqual(
      [inChapter1, inChapter2, inSummary].map((k) => img + k).sort(),
    );
  });

  it("A held version's images are referenced, and young images are kept", async () => {
    const ao3WorkId = freshAo3WorkId();
    const [inHeld, unreferenced] = [imageKey(), imageKey()];
    const work = await seededWork({ ao3WorkId });
    await seededVersion(work, { chapters: [{ html: withImages(ao3WorkId, inHeld) }] });
    await putImages(ao3WorkId, inHeld, unreferenced);
    const img = `works/${ao3WorkId}/img/`;

    await runSweep(0);
    expect(await bucketKeys(img)).toEqual([img + inHeld, img + unreferenced].sort());

    await runSweep(25);
    expect(await bucketKeys(img)).toEqual([img + inHeld]);
  });

  it("No image is deleted while an upload of the work is pending or processing", async () => {
    const ao3WorkId = freshAo3WorkId();
    const work = await seededWork({ ao3WorkId });
    // A job writes its fragments before its images: its prefix ties it to the work.
    await putPrefix(ao3WorkId, await upload(work.userId, "processing"), 1);
    const unreferenced = imageKey();
    await putImages(ao3WorkId, unreferenced);

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/img/`)).toEqual([
      `works/${ao3WorkId}/img/${unreferenced}`,
    ]);
  });

  it("No image is deleted when a version's fragment can't be read", async () => {
    const ao3WorkId = freshAo3WorkId();
    const work = await seededWork({ ao3WorkId, chapters: 2 });
    const [, second] = work.chapterKeys;
    // SAFETY: the work was seeded with two chapters.
    await env.BUCKET.delete(second as string);
    const unreferenced = imageKey();
    await putImages(ao3WorkId, unreferenced);

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/img/`)).toEqual([
      `works/${ao3WorkId}/img/${unreferenced}`,
    ]);
  });

  it("A folder with no work holds only unreferenced images and orphaned prefixes", async () => {
    // A first upload whose save was refused: no works row, so nothing references its files.
    const ao3WorkId = freshAo3WorkId();
    await putPrefix(ao3WorkId, await upload(null, "parse_failed"), 2);
    await putImages(ao3WorkId, imageKey());
    const onlyImages = freshAo3WorkId();
    await putImages(onlyImages, imageKey());

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual([]);
    expect(await bucketKeys(`works/${onlyImages}/`)).toEqual([]);
  });
});

describe("sweep bounds", () => {
  /** Two works, each with an unreferenced image; returns their img prefixes in R2's order. */
  async function twoWorks(): Promise<[string, string]> {
    const [a, b] = [freshAo3WorkId(), freshAo3WorkId()];
    const ids = `works/${a}/` < `works/${b}/` ? [a, b] : [b, a];
    for (const ao3WorkId of ids) {
      await seededWork({ ao3WorkId });
      await putImages(ao3WorkId, imageKey());
    }
    return [`works/${ids[0]}/img/`, `works/${ids[1]}/img/`];
  }

  it("A run sweeps a bounded number of works, and the next run goes on from there", async () => {
    const [first, second] = await twoWorks();
    const handler = sweepWorker({ works: 1, subrequests: 1000 });

    await runSweep(25, { handler });
    expect(await bucketKeys(first)).toEqual([]);
    expect(await bucketKeys(second)).toHaveLength(1);

    await runSweep(25, { handler });
    expect(await bucketKeys(second)).toEqual([]);
  });

  it("A work the run's budget can't finish keeps its images", async () => {
    const [first, second] = await twoWorks();
    // Enough to list the folders and the first work's prefixes, not its images.
    const handler = sweepWorker({ works: 10, subrequests: 2 });

    await runSweep(25, { handler });
    expect(await bucketKeys(first)).toHaveLength(1);
    expect(await bucketKeys(second)).toHaveLength(1);

    // The next runs go on past it rather than stopping on it every day.
    await runSweep(25, { handler: sweepWorker({ works: 10, subrequests: 1000 }) });
    expect(await bucketKeys(first)).toHaveLength(1);
    expect(await bucketKeys(second)).toEqual([]);
  });
});

describe("sweep of orphaned version prefixes", () => {
  it("A prefix no version points at is deleted, and every version's prefix is kept", async () => {
    const ao3WorkId = freshAo3WorkId();
    const work = await seededWork({ ao3WorkId, chapters: 2 });
    const held = await seededVersion(work);
    // A refused save's leftovers: fragments, with no version row.
    const refused = await upload(work.userId, "parse_failed");
    await putPrefix(ao3WorkId, refused, 3);

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual(
      [...work.chapterKeys, ...held.chapterKeys].sort(),
    );
  });

  it("A duplicate upload's prefix is deleted, and a held upload's is kept", async () => {
    const ao3WorkId = freshAo3WorkId();
    const work = await seededWork({ ao3WorkId });
    // A duplicate's job stored its fragments but no version; a held one has its version.
    const duplicate = await upload(work.userId, "duplicate");
    await putPrefix(ao3WorkId, duplicate, 1);
    const held = await seededVersion(work);

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual(
      [...work.chapterKeys, ...held.chapterKeys].sort(),
    );
  });

  it("A prefix younger than 24 hours is kept", async () => {
    const ao3WorkId = freshAo3WorkId();
    const work = await seededWork({ ao3WorkId });
    const refused = await putPrefix(ao3WorkId, await upload(work.userId, "parse_failed"), 2);

    await runSweep(23);

    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual(
      [...work.chapterKeys, ...refused].sort(),
    );
  });

  it("A second sweep deletes nothing more", async () => {
    const ao3WorkId = freshAo3WorkId();
    const keep = imageKey();
    const work = await seededWork({ ao3WorkId, chapters: [{ html: withImages(ao3WorkId, keep) }] });
    await putImages(ao3WorkId, keep, imageKey());
    await putPrefix(ao3WorkId, await upload(work.userId, "parse_failed"), 1);

    await runSweep(25);
    const after = await bucketKeys(`works/${ao3WorkId}/`);
    await runSweep(25);

    expect(after).toEqual([...work.chapterKeys, `works/${ao3WorkId}/img/${keep}`].sort());
    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual(after);
  });

  it("A prefix of an upload still pending or processing is kept", async () => {
    const ao3WorkId = freshAo3WorkId();
    const work = await seededWork({ ao3WorkId });
    const processing = await putPrefix(ao3WorkId, await upload(work.userId, "processing"), 2);
    // Pending and confirmed: one in the queue. An unconfirmed one this old would be reaped.
    const queued = await upload(work.userId, "pending", { confirmed: new Date() });
    const pending = await putPrefix(ao3WorkId, queued, 1);

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual(
      [...work.chapterKeys, ...processing, ...pending].sort(),
    );
  });
});

describe("02-upload-handshake: unconfirmed uploads", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.now();
  const daysAgo = (days: number) => new Date(NOW - days * DAY);
  const keyOf = (id: string) => `uploads/${id}.epub`;

  /** Whether the upload's row is still there. */
  const hasRow = (id: string) =>
    withDb(async (db) => {
      const row = await db
        .selectFrom("uploads")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst();
      return row !== undefined;
    });

  it("An unconfirmed upload older than a day is removed, with any file", async () => {
    const withFile = await upload(null, "pending", { createdAt: daysAgo(2) });
    await env.BUCKET.put(keyOf(withFile), "synthetic");
    const neverPut = await upload(null, "pending", { createdAt: daysAgo(2) });
    // Young, so the sweep's own rules keep them: what goes here is the reaper's doing.
    await env.BUCKET.put("works/60000/1.html", "<p>Synthetic fragment.</p>");
    await env.BUCKET.put("originals/60000.epub", "synthetic");

    await runSweep(0, { at: NOW });

    expect(await hasRow(withFile)).toBe(false);
    expect(await hasRow(neverPut)).toBe(false);
    expect(await bucketKeys("")).toEqual(["originals/60000.epub", "works/60000/1.html"]);
  });

  it("An unconfirmed upload not yet a day old stays", async () => {
    const atTheLine = await upload(null, "pending", { createdAt: daysAgo(1) });
    await env.BUCKET.put(keyOf(atTheLine), "synthetic");
    const justOver = await upload(null, "pending", { createdAt: new Date(NOW - DAY - 1) });

    await runSweep(0, { at: NOW });

    expect(await hasRow(atTheLine)).toBe(true);
    expect(await bucketKeys("uploads/")).toEqual([keyOf(atTheLine)]);
    expect(await hasRow(justOver)).toBe(false);
  });

  it("A confirmed upload is never removed, whatever its age", async () => {
    const old = { createdAt: daysAgo(400) };
    const ids = [
      await upload(null, "pending", { ...old, confirmed: daysAgo(400) }),
      await upload(null, "processing", old),
      await upload(null, "live", old),
      await upload(null, "held_for_review", old),
      await upload(null, "duplicate", old),
      await upload(null, "parse_failed", old),
      await upload(null, "too_large", old),
      await upload(null, "over_quota", old),
    ];
    for (const id of ids) await env.BUCKET.put(keyOf(id), "synthetic");

    await runSweep(0, { at: NOW });

    for (const id of ids) expect(await hasRow(id), id).toBe(true);
    expect(await bucketKeys("uploads/")).toEqual(ids.map(keyOf).sort());
  });

  it("The age is the deployed configuration's, and a bad value is a day", async () => {
    const twoDaysOld = await upload(null, "pending", { createdAt: daysAgo(2) });
    await runSweep(0, { at: NOW, bindings: { ...env, UNCONFIRMED_UPLOAD_DAYS: "3" } });
    expect(await hasRow(twoDaysOld)).toBe(true);

    // Zero would take a link still in use: never less than the day it falls back to.
    const hourOld = await upload(null, "pending", { createdAt: new Date(NOW - DAY / 24) });
    for (const bad of ["0", "-1", "1e3", "", "soon"]) {
      await runSweep(0, { at: NOW, bindings: { ...env, UNCONFIRMED_UPLOAD_DAYS: bad } });
      expect(await hasRow(hourOld), bad).toBe(true);
    }
    expect(await hasRow(twoDaysOld)).toBe(false);
  });

  it("A file that can't be deleted leaves the run going, and the row removed", async () => {
    const stale = await upload(null, "pending", { createdAt: daysAgo(2) });
    await env.BUCKET.put(keyOf(stale), "synthetic");
    const work = await seededWork({ ao3WorkId: freshAo3WorkId() });
    const unreferenced = imageKey();
    await putImages(work.ao3WorkId, unreferenced);
    // Only the reaper's delete fails: the image's goes through, which shows the sweep still ran.
    // SAFETY: the Worker calls only these three of the bucket's methods (SweepBucket).
    const bucket = {
      list: (options?: R2ListOptions) => env.BUCKET.list(options),
      get: (key: string) => env.BUCKET.get(key),
      delete: async (keys: string[]) => {
        if (keys.some((k) => k.startsWith("uploads/"))) throw new TypeError("no delete");
        await env.BUCKET.delete(keys);
      },
    } as unknown as R2Bucket;

    await runSweep(25, { bindings: { ...env, BUCKET: bucket } });

    expect(await hasRow(stale)).toBe(false);
    // The bucket's lifecycle rule is what takes it now.
    expect(await bucketKeys("uploads/")).toEqual([keyOf(stale)]);
    expect(await bucketKeys(`works/${work.ao3WorkId}/img/`)).toEqual([]);
  });
});

describe("sweep of a removed work", () => {
  // Fixed ids from this item's range; the neighbour's folder name extends the removed one's.
  // The database is shared by every test, so each takes its own removed work's id (43010-43019).
  let REMOVED = 43_009;
  let NEIGHBOUR = 430_090;
  beforeEach(() => {
    REMOVED++;
    NEIGHBOUR = REMOVED * 10;
  });
  const original = (uploadId: string) => `originals/${uploadId}.epub`;

  it("A removed work's leftover files are deleted by the next run", async () => {
    await seededWork({ ao3WorkId: REMOVED, status: "removed" });
    const refused = await upload(null, "parse_failed");
    await putPrefix(REMOVED, refused, 2);
    await putImages(REMOVED, imageKey());
    await env.BUCKET.put(original(refused), "synthetic");
    await env.BUCKET.put(`works/${NEIGHBOUR}/1.html`, "<p>Neighbour.</p>");

    // No age cutoff: everything here is young.
    await runSweep(0);

    expect(await bucketKeys(`works/${REMOVED}/`)).toEqual([]);
    expect(await bucketKeys(original(refused))).toEqual([]);
    expect(await bucketKeys(`works/${NEIGHBOUR}/`)).toEqual([`works/${NEIGHBOUR}/1.html`]);
  });

  it("A live or hidden work's files are never touched", async () => {
    const live = await seededWork({ ao3WorkId: 43_002 });
    const hidden = await seededWork({
      ao3WorkId: 43_003,
      status: "hidden",
      hiddenCause: "moderator",
    });
    const strays: string[] = [];
    for (const work of [live, hidden]) {
      const stray = await upload(work.userId, "parse_failed");
      strays.push(...(await putPrefix(work.ao3WorkId, stray, 1)));
      await env.BUCKET.put(original(stray), "synthetic");
      await putImages(work.ao3WorkId, imageKey());
    }
    const before = await bucketKeys("");

    // Even a run a day later takes only what the old rules take: young leftovers stay now, and
    // the removed rule has no say over these works.
    await runSweep(0);
    expect(await bucketKeys("")).toEqual(before);

    await runSweep(25);
    for (const work of [live, hidden]) {
      for (const key of work.chapterKeys) expect(await bucketKeys(key)).toEqual([key]);
    }
    expect(await bucketKeys("originals/")).toHaveLength(2);
  });

  it("A work with a job running is left for a later run", async () => {
    const work = await seededWork({ ao3WorkId: REMOVED, status: "removed" });
    const processing = await upload(work.userId, "processing");
    const pending = await upload(work.userId, "pending");
    await putPrefix(REMOVED, processing, 1);
    await putPrefix(REMOVED, pending, 1);
    await env.BUCKET.put(original(processing), "synthetic");
    const before = await bucketKeys("");

    await runSweep(0);
    expect(await bucketKeys("")).toEqual(before);

    // The jobs end: the next run deletes what they left.
    await withDb((db) =>
      db
        .updateTable("uploads")
        .set({ status: "parse_failed" })
        .where("id", "in", [processing, pending])
        .execute(),
    );
    await runSweep(0);
    expect(await bucketKeys(`works/${REMOVED}/`)).toEqual([]);
    expect(await bucketKeys(original(processing))).toEqual([]);
  });

  it("A second run deletes nothing more", async () => {
    await seededWork({ ao3WorkId: REMOVED, status: "removed" });
    await putPrefix(REMOVED, await upload(null, "parse_failed"), 1);
    await env.BUCKET.put(`works/${NEIGHBOUR}/1.html`, "<p>Neighbour.</p>");

    await runSweep(0);
    const after = await bucketKeys("");
    await runSweep(0);

    expect(await bucketKeys(`works/${REMOVED}/`)).toEqual([]);
    expect(await bucketKeys("")).toEqual(after);
  });
});
