import { describe, expect, it } from "vitest";
import { ao3Epub, type SpineFile } from "../../../packages/epub/test/helpers";
import { ingestReal, liveWork, versionsOf } from "./helpers";

// AO3 work id 40610 is this file's. Synthetic text only.

/** Chapters of sixty words of their own, identical in every epub built from them. */
const chapterFiles = (count: number): SpineFile[] =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const words = Array.from({ length: 60 }, (_, w) => `f${n}x${w}`).join(" ");
    return {
      name: `Flagged_${n}.xhtml`,
      body: `<div id="chapters"><h2 class="toc-heading" id="t${n}">Chapter ${n}</h2><div class="userstuff2"><p>${words}</p></div></div>`,
    };
  });

/** An epub of `count` chapters whose Stats line says `stats`. */
const epubOf = (workId: number, count: number, stats: string) =>
  ao3Epub({
    workId,
    stats,
    files: chapterFiles(count),
    navPoints: chapterFiles(count).map((f, i) => ({ label: `${i + 1}. Chapter`, src: f.name })),
  });

describe("08-versioning-and-dedupe: flagged upload", () => {
  it("Flagged newer upload replaces and shows the notice", async () => {
    const workId = 40610;
    const v1 = await ingestReal(epubOf(workId, 3, "Chapters: 3/3"));
    expect(v1.row.status).toBe("live");
    const before = await versionsOf(workId);
    expect(before.versions[0]?.review_reasons).toEqual([]);

    // Four chapters, the first three unchanged, and a Stats line that disagrees.
    const v2 = await ingestReal(epubOf(workId, 4, "Chapters: 5/5"));

    expect(v2.row.status).toBe("live");
    const rows = await versionsOf(workId);
    expect(rows.versions).toHaveLength(2);
    const second = rows.versions.find((v) => v.upload_id === v2.id);
    expect(rows.current).toBe(second?.id);
    expect(second?.review_reasons).toEqual(["chapter_count_mismatch: parsed 4, Stats says 5"]);
    expect(second?.hold_reason).toBeNull();
    expect(second?.checked_at).toBeNull();
    const live = await liveWork(workId);
    expect(live?.version.review_reasons).toEqual(second?.review_reasons);
    expect(live?.chapters.map((c) => c.n)).toEqual([1, 2, 3, 4]);
  });
});
