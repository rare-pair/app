import { ao3Epub } from "../../../../packages/epub/test/build";

// Epubs the journeys build in memory, so a test can make a work, a second version of it, or a
// changed one without committing a fixture. Synthetic numbered filler only: no fic text.

export type GeneratedEpub = {
  /** The AO3 work id in the preface link: versions of one work share it. */
  workId: number;
  title?: string;
  /** Chapters in the file. Default 1. */
  chapters?: number;
  /** The chapter total the stats line claims (`Chapters: 2/3`). Default: `chapters`. */
  planned?: number;
  /** The `Updated:` date, `YYYY-MM-DD`; unset leaves only `Published:`. */
  updated?: string;
  /** Chapter numbers whose text is wholly different prose, as a rewrite is. */
  rewritten?: number[];
};

/** Five paragraphs of five numbered sentences, about 300 words: a small edit stays under 10%. */
function chapterText(workId: number, n: number, rewritten: boolean): string[] {
  return Array.from({ length: 5 }, (_, p) =>
    Array.from({ length: 5 }, (_, s) => {
      const k = p * 5 + s + 1;
      return rewritten
        ? `Passage ${k} about nothing at all, in wholly other wording than before (work ${workId}, chapter ${n}).`
        : `Sentence ${k} of the synthetic work ${workId} chapter ${n}, filler text with no meaning.`;
    }).join(" "),
  );
}

/** The wording of chapter `n` of work `workId` that every version of it shares. */
export const chapterSentence = (workId: number, n: number, k = 1) =>
  `Sentence ${k} of the synthetic work ${workId} chapter ${n}`;

/**
 * An AO3-shaped epub of `chapters` chapters, as bytes. The same spec gives the same bytes, so
 * two builds of one spec are a duplicate; more chapters or a later `updated` date, with the
 * shared chapters alike, is a newer version; a rewritten chapter makes it a changed one.
 */
export function generatedEpub({
  workId,
  title = `Synthetic Work ${workId}`,
  chapters = 1,
  planned = chapters,
  updated,
  rewritten = [],
}: GeneratedEpub): Uint8Array {
  const texts = Array.from({ length: chapters }, (_, i) =>
    chapterText(workId, i + 1, rewritten.includes(i + 1)),
  );
  const words = texts.flat().join(" ").split(/\s+/).length;
  const regions = texts.map(
    (paragraphs, i) =>
      `<h2 class="toc-heading" id="c${i + 1}">Chapter ${i + 1}</h2>\n<div class="userstuff2">${paragraphs
        .map((t) => `<p class="calibre7">${t}</p>`)
        .join("\n")}</div>`,
  );
  const file = `Synthetic_${workId}_split_001.xhtml`;
  return ao3Epub({
    workId,
    title,
    stats: `Published: 2020-01-02 ${updated === undefined ? "" : `Updated: ${updated} `}Chapters: ${chapters}/${planned} Words: ${words}`,
    files: [
      {
        name: file,
        body: `<div id="chapters" class="userstuff1">${regions.join("\n")}</div>`,
      },
    ],
    navPoints: texts.map((_, i) => ({ label: `${i + 1}. Chapter`, src: `${file}#c${i + 1}` })),
  });
}
