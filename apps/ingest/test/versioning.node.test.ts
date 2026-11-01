import type { TagType } from "@archive/db";
import { describe, expect, it } from "vitest";
import { decideVersion, type VersionFacts } from "../src/versioning";

/** Invented chapter text: `words` distinct made-up words per `seed`, so seeds never overlap. */
function body(seed: string, words = 200): string {
  return Array.from({ length: words }, (_, i) => `${seed}${i}`).join(" ");
}

function facts(
  over: Partial<Omit<VersionFacts, "chapters">> & { chapters?: number } = {},
): VersionFacts {
  const { chapters = 3, ...rest } = over;
  return {
    date: "2026-01-10",
    chapters: Array.from({ length: chapters }, (_, i) => ({
      n: i + 1,
      text: `<p>${body(`c${i + 1}x`)}</p>`,
    })),
    tags: [tag("fandom", "Invented Fandom"), tag("freeform", "Fluff")],
    authors: [{ pseud: "Moon Writer", user: "moonwriter" }],
    ...rest,
  };
}

/** `base` with chapter `n`'s text swapped. */
function withChapter(base: VersionFacts, n: number, text: string): VersionFacts {
  return { ...base, chapters: base.chapters.map((c) => (c.n === n ? { n, text } : c)) };
}

function tag(type: TagType, name: string): VersionFacts["tags"][number] {
  return { type, name };
}

const REPLACE = { outcome: "replace" };
const DUPLICATE = { outcome: "duplicate", reason: "not_newer" };

describe("08 versioning and dedupe: decideVersion", () => {
  it("Newer upload with more chapters replaces the current version", () => {
    expect(decideVersion(facts(), facts({ chapters: 4 }))).toEqual(REPLACE);
  });

  it("Newer upload with a later date replaces the current version", () => {
    expect(decideVersion(facts(), facts({ date: "2026-02-01" }))).toEqual(REPLACE);
  });

  it("Small edits in shared chapters are allowed", () => {
    const upload = facts({ chapters: 4 });
    const edited = withChapter(upload, 2, `<p>${body("c2x").replace("c2x57", "c2x57typo")}</p>`);
    expect(decideVersion(facts(), edited)).toEqual(REPLACE);
  });

  it("Newer upload with changed shared chapters is held", () => {
    const upload = withChapter(facts({ chapters: 4 }), 2, `<p>${body("rewritten")}</p>`);
    expect(decideVersion(facts(), upload)).toEqual({ outcome: "hold", reason: "chapters_changed" });
  });

  it("Newer upload with changed tags is held", () => {
    const tags = [tag("fandom", "Invented Fandom"), tag("freeform", "Angst")];
    expect(decideVersion(facts(), facts({ chapters: 4, tags }))).toEqual({
      outcome: "hold",
      reason: "tags_changed",
    });
  });

  it("Newer upload with changed authors is held", () => {
    const authors = [{ pseud: "Star Writer", user: "starwriter" }];
    expect(decideVersion(facts(), facts({ chapters: 4, authors }))).toEqual({
      outcome: "hold",
      reason: "authors_changed",
    });
  });

  it("Older upload is marked duplicate", () => {
    expect(decideVersion(facts(), facts({ chapters: 2, date: "2025-12-01" }))).toEqual(DUPLICATE);
  });

  it("Same-version upload is marked duplicate", () => {
    const upload = withChapter(facts(), 2, `<p>${body("other")}</p>`);
    expect(decideVersion(facts(), upload)).toEqual(DUPLICATE);
  });

  it("Nobody gets special treatment", () => {
    // The facts carry no uploader, so an author's own update and a stranger's upload of the same
    // file are the same input. An update whose bylines equal the current version's is judged on
    // the same rules: it replaces when consistent and is held when a chapter was rewritten.
    const own = facts({ chapters: 4, authors: facts().authors });
    expect(decideVersion(facts(), own)).toEqual(REPLACE);
    const tampered = withChapter(own, 1, `<p>${body("rewritten")}</p>`);
    expect(decideVersion(facts(), tampered)).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });

  it("Authors update works the same way as anyone", () => {
    const update = facts({ chapters: 5, date: "2026-03-01" });
    expect(decideVersion(facts(), update)).toEqual(REPLACE);
    expect(decideVersion(facts(), withChapter(update, 3, `<p>${body("rewritten")}</p>`))).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });
});

describe("decideVersion edges", () => {
  it("is not newer at equal chapter count and date, even with a changed chapter", () => {
    expect(decideVersion(facts(), withChapter(facts(), 1, "<p>other words here</p>"))).toEqual(
      DUPLICATE,
    );
  });

  it("is newer with fewer chapters and a later date", () => {
    expect(decideVersion(facts(), facts({ chapters: 2, date: "2026-02-01" }))).toEqual(REPLACE);
  });

  it("is newer with more chapters and an earlier date", () => {
    expect(decideVersion(facts(), facts({ chapters: 4, date: "2025-01-01" }))).toEqual(REPLACE);
  });

  it("never counts a missing date as newer", () => {
    expect(decideVersion(facts({ date: null }), facts({ date: "2026-02-01" }))).toEqual(DUPLICATE);
    expect(decideVersion(facts(), facts({ date: null }))).toEqual(DUPLICATE);
    expect(decideVersion(facts({ date: null }), facts({ date: null }))).toEqual(DUPLICATE);
    expect(decideVersion(facts({ date: null }), facts({ date: null, chapters: 4 }))).toEqual(
      REPLACE,
    );
  });

  it("treats a date that is not YYYY-MM-DD as missing", () => {
    expect(decideVersion(facts(), facts({ date: "tomorrow" }))).toEqual(DUPLICATE);
  });

  it("holds no judgement on chapters when none are shared", () => {
    expect(decideVersion(facts({ chapters: 0 }), facts({ chapters: 2 }))).toEqual(REPLACE);
  });

  it("does not throw on empty chapters, tags and authors", () => {
    const empty: VersionFacts = { date: null, chapters: [], tags: [], authors: [] };
    expect(decideVersion(empty, empty)).toEqual(DUPLICATE);
    expect(decideVersion(empty, { ...empty, date: "2026-01-01" })).toEqual(DUPLICATE);
  });

  it("is replaced when tags and authors are both empty on both sides", () => {
    const bare = { tags: [], authors: [] };
    expect(decideVersion(facts(bare), facts({ ...bare, chapters: 4 }))).toEqual(REPLACE);
  });

  it("ignores the order of tags and authors", () => {
    const current = facts({
      authors: [
        { pseud: "Moon Writer", user: "moonwriter" },
        { pseud: "Star Writer", user: null },
      ],
    });
    const upload = facts({
      chapters: 4,
      tags: [...facts().tags].reverse(),
      authors: [...current.authors].reverse(),
    });
    expect(decideVersion(current, upload)).toEqual(REPLACE);
  });

  it("compares tags and pseuds by their normalized names", () => {
    const upload = facts({
      chapters: 4,
      tags: [tag("fandom", "  invented   FANDOM "), tag("freeform", "fluff")],
      authors: [{ pseud: "moon  writer", user: "moonwriter" }],
    });
    expect(decideVersion(facts(), upload)).toEqual(REPLACE);
  });

  it("holds a tag moved to another type, and a tag added or removed", () => {
    const moved = facts({
      chapters: 4,
      tags: [tag("freeform", "Invented Fandom"), tag("freeform", "Fluff")],
    });
    expect(decideVersion(facts(), moved)).toEqual({ outcome: "hold", reason: "tags_changed" });
    const added = facts({
      chapters: 4,
      tags: [...facts().tags, tag("rating", "G")],
    });
    expect(decideVersion(facts(), added)).toEqual({ outcome: "hold", reason: "tags_changed" });
    const removed = facts({ chapters: 4, tags: facts().tags.slice(1) });
    expect(decideVersion(facts(), removed)).toEqual({ outcome: "hold", reason: "tags_changed" });
  });

  it("holds an author whose AO3 user changed, or who was added", () => {
    const user = facts({ chapters: 4, authors: [{ pseud: "Moon Writer", user: "someoneelse" }] });
    expect(decideVersion(facts(), user)).toEqual({ outcome: "hold", reason: "authors_changed" });
    const added = facts({
      chapters: 4,
      authors: [...facts().authors, { pseud: "Star Writer", user: null }],
    });
    expect(decideVersion(facts(), added)).toEqual({ outcome: "hold", reason: "authors_changed" });
  });

  it("allows markup, case-preserving whitespace and reflow differences only", () => {
    const upload = withChapter(
      facts({ chapters: 4 }),
      1,
      `<div>\n  <p>${body("c1x", 100)}</p>\n<p>${body("c1x", 200).split(" ").slice(100).join("\n")}</p></div>`,
    );
    expect(decideVersion(facts(), upload)).toEqual(REPLACE);
    const recased = withChapter(facts({ chapters: 4 }), 1, body("c1x").toUpperCase());
    expect(decideVersion(facts(), recased)).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });

  it("pairs chapters by number, not by position", () => {
    const current = facts();
    const upload = facts({ chapters: 4 });
    expect(decideVersion(current, { ...upload, chapters: [...upload.chapters].reverse() })).toEqual(
      REPLACE,
    );
  });

  it("holds when only the last shared chapter is rewritten", () => {
    const upload = withChapter(facts({ chapters: 4 }), 3, `<p>${body("rewritten")}</p>`);
    expect(decideVersion(facts(), upload)).toEqual({ outcome: "hold", reason: "chapters_changed" });
  });

  it("holds an emptied shared chapter and a chapter of a single word", () => {
    expect(decideVersion(facts(), withChapter(facts({ chapters: 4 }), 1, ""))).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
    const one = withChapter(facts(), 1, "solo");
    expect(decideVersion(one, withChapter(facts({ chapters: 4 }), 1, "solo"))).toEqual(REPLACE);
    expect(decideVersion(one, withChapter(facts({ chapters: 4 }), 1, "other"))).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });

  it("takes the similarity threshold as a parameter, at or above it passing", () => {
    // Replacing 1 word in 11 changes 2 of 10 word pairs: 80% alike.
    const current = withChapter(facts(), 1, "a b c d e f g h i j k");
    const upload = withChapter(facts({ chapters: 4 }), 1, "a b c d e X g h i j k");
    expect(decideVersion(current, upload)).toEqual({ outcome: "hold", reason: "chapters_changed" });
    expect(decideVersion(current, upload, { threshold: 0.8 })).toEqual(REPLACE);
    expect(decideVersion(current, upload, { threshold: 0.81 })).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });

  it("pairs chapters by number when the numbers are not contiguous", () => {
    const current = facts();
    const skipped = facts({ chapters: 0 });
    skipped.chapters = [1, 3, 4].map((n) => ({
      n,
      text: current.chapters[n - 1]?.text ?? `<p>${body("new")}</p>`,
    }));
    expect(decideVersion(current, { ...skipped, date: "2026-02-01" })).toEqual(REPLACE);
    skipped.chapters[1] = { n: 3, text: `<p>${body("rewritten")}</p>` };
    expect(decideVersion(current, { ...skipped, date: "2026-02-01" })).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });

  it("treats an impossible calendar date as missing", () => {
    for (const date of ["2026-13-01", "2026-02-30", "9999-99-99", "2026-00-10"]) {
      expect(decideVersion(facts(), facts({ date }))).toEqual(DUPLICATE);
    }
  });

  it("refuses a similarity threshold outside 0 to 1", () => {
    for (const threshold of [Number.NaN, -0.1, 1.1]) {
      expect(() => decideVersion(facts(), facts({ chapters: 4 }), { threshold })).toThrow(
        RangeError,
      );
    }
    expect(decideVersion(facts(), facts({ chapters: 4 }), { threshold: 1 })).toEqual(REPLACE);
    expect(decideVersion(facts(), facts({ chapters: 4 }), { threshold: 0 })).toEqual(REPLACE);
  });

  it("holds just under the default 90% and allows exactly 90%", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
    const edited = (n: number) => words(n).map((w, i) => (i === Math.floor(n / 2) ? "X" : w));
    // 21 words give 20 pairs; one changed word breaks 2: 18 of 20 in common, 36/40 = 0.9.
    const exact = withChapter(facts({ chapters: 4 }), 1, edited(21).join(" "));
    expect(decideVersion(withChapter(facts(), 1, words(21).join(" ")), exact)).toEqual(REPLACE);
    // 19 words give 18 pairs: 16 of 18 in common, 32/36 is under 0.9.
    const under = withChapter(facts({ chapters: 4 }), 1, edited(19).join(" "));
    expect(decideVersion(withChapter(facts(), 1, words(19).join(" ")), under)).toEqual({
      outcome: "hold",
      reason: "chapters_changed",
    });
  });

  it("compares an author's AO3 user without regard to case", () => {
    const authors = [{ pseud: "Moon Writer", user: "MoonWriter" }];
    expect(decideVersion(facts(), facts({ chapters: 4, authors }))).toEqual(REPLACE);
  });

  it("puts not newer before every hold", () => {
    const upload = facts({
      tags: [],
      authors: [],
      chapters: 2,
      date: "2025-01-01",
    });
    expect(decideVersion(facts(), upload)).toEqual(DUPLICATE);
  });
});
