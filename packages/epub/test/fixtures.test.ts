import { describe, expect, it, inject } from "vitest";
import { processEpub, type ParsedWork } from "../src";
import { fromBase64 } from "./helpers";

// Two sets of fixtures run here. The synthetic ones in fixtures/epubs/synthetic/ are
// committed, with their expected.json, so these tests always run. Real AO3 epubs live
// in fixtures/epubs/ locally and are git-ignored (the repo is public): the repo holds
// no real text and no expected values; those live in the git-ignored
// fixtures/epubs/expected.json (see expected.example.json), keyed by epub file name.
// Each expected string is compared by the SHA-256 of its UTF-8 bytes. A fixture with
// no entry gets the generic checks only.

const fixtures = inject("epubFixtures");
const EXPECTED = inject("epubExpected");
const names = Object.keys(fixtures);
const syntheticNames = inject("epubSyntheticNames");

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function shas(values: string[]): Promise<string[]> {
  return Promise.all(values.map(sha256));
}

function expectClean(html: string): void {
  expect(html).not.toMatch(/class=|style=|<script|calibre|\son\w+=/i);
}

describe.skipIf(names.length === 0)("epub fixtures (all present)", () => {
  it.each(names)("%s: parses deterministically and sanitizes everything", async (name) => {
    const bytes = fromBase64(fixtures[name]!);
    const a = await processEpub(bytes);
    const b = await processEpub(bytes);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.chapters.length).toBeGreaterThan(0);
    for (const html of [
      a.summaryHtml,
      a.notesHtml,
      a.endNotesHtml,
      ...a.chapters.map((c) => c.html),
    ]) {
      if (html !== null) expectClean(html);
    }
    // Recorded for the report: our word count vs AO3's.
    console.log(
      `${name}: AO3 words ${a.stats.words}, counted ${a.chapters.reduce((n, c) => n + c.words, 0)}`,
    );
  });
});

// Synthetic fixtures only: real ones are fanworks, so their output stays out of the repo.
// A changed snapshot must be listed in the PR with the reason.
describe.skipIf(syntheticNames.length === 0)("synthetic fixture snapshots", () => {
  it.each(syntheticNames)("%s", async (name) => {
    expect(await processEpub(fromBase64(fixtures[name]!))).toMatchSnapshot();
  });
});

for (const [name, want] of Object.entries(EXPECTED)) {
  describe.skipIf(!(name in fixtures))(`fixture ${name}`, () => {
    let work: ParsedWork | undefined;
    const load = async () => (work ??= await processEpub(fromBase64(fixtures[name]!)));

    it("reads the preface metadata", async () => {
      const w = await load();
      expect(await sha256(w.ao3WorkId)).toBe(want.workIdSha);
      expect(await sha256(w.title)).toBe(want.titleSha);
      expect(
        await Promise.all(
          w.authors.map(async (a) => ({
            pseudSha: await sha256(a.pseud),
            userSha: a.user === null ? null : await sha256(a.user),
          })),
        ),
      ).toEqual(want.authors);
      expect(w.rating).toBe(want.rating);
      expect(w.warnings).toEqual(["No Archive Warnings Apply"]);
      expect(w.categories).toEqual(["M/M"]);
      expect(await shas(w.fandoms)).toEqual(want.fandomShas);
      expect(w.relationships).toHaveLength(want.relationships);
      if (want.relationshipIncludesSha) {
        expect(await shas(w.relationships)).toContain(want.relationshipIncludesSha);
      }
      expect(w.characters).toHaveLength(want.characters);
      expect(w.freeforms).toHaveLength(want.freeforms);
      expect(w.language).toBe("English");
      expect(w.series).toEqual([]);
      expect(w.stats).toEqual({
        published: want.published,
        updated: null,
        completed: null,
        words: want.words,
        chapters: { posted: 1, total: 1 },
      });
      expect(w.rawMeta).toEqual({});
      expect(w.reviewReasons).toEqual([]);
      expect(w.images).toEqual([]);
    });

    it("finds exactly one chapter with the work title", async () => {
      const w = await load();
      expect(w.chapters).toHaveLength(1);
      const [chapter] = w.chapters;
      expect(chapter!.n).toBe(1);
      expect(await sha256(chapter!.title)).toBe(want.titleSha);
      expect(chapter!.html.length).toBeGreaterThan(1000);
      const { offset, length, sha } = want.opening;
      const collapsed = chapter!.html.replace(/\s+/g, " ");
      expect(await sha256(collapsed.slice(offset, offset + length))).toBe(sha);
      expect(chapter!.html).not.toMatch(/<h2/);
      expect(chapter!.words).toBeGreaterThan(want.words * 0.9);
      expectClean(chapter!.html);
    });

    it("keeps summary, notes and end notes, sanitized", async () => {
      const w = await load();
      for (const html of [w.summaryHtml, w.notesHtml, w.endNotesHtml]) {
        expect(html).toMatch(/^<p>/);
        expectClean(html!);
      }
      expect(w.notesHtml).not.toMatch(/See the end of the work/);
    });

    it("drops the archive's comment prompt", async () => {
      const w = await load();
      expect(JSON.stringify(w)).not.toMatch(/drop by the archive and comment/i);
    });
  });
}
