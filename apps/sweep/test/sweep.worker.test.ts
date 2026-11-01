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
    // Enough to list the folders and the first work's prefixes, not to read its fragment.
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
    const pending = await putPrefix(ao3WorkId, await upload(work.userId, "pending"), 1);

    await runSweep(25);

    expect(await bucketKeys(`works/${ao3WorkId}/`)).toEqual(
      [...work.chapterKeys, ...processing, ...pending].sort(),
    );
  });
});
