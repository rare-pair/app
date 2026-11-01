import { beforeEach, describe, expect, it } from "vitest";
import {
  bucketKeys,
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

// Every sweep test is in this file, so they run one after another: the sweep's state row is
// shared by the whole database, and each test starts it from the first folder.
beforeEach(resetSweepState);

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
});
