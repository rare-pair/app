import { describe, expect, it } from "vitest";
import { readWork, type PageLink, type TextLine } from "../src/pdf/structure";

// The work reader on lines and links as the parser hands them over, for what a PDF can't be built
// to show cheaply. Synthetic text only.

const posted: TextLine = {
  page: 1,
  x: 72,
  y: 700,
  size: 11,
  right: 500,
  text: "Posted originally on the Archive of Our Own at https://archiveofourown.org/works/8813740.",
};
const stats: TextLine = {
  page: 1,
  x: 72,
  y: 686,
  size: 11,
  right: 300,
  text: "Stats: Chapters: 1/1",
};
const title: TextLine = { page: 1, x: 72, y: 660, size: 18, right: 200, text: "A title" };

/** A line of `text` at `y`, `width` points per character, from the left margin. */
const line = (text: string, y: number, width = 5.5): TextLine => ({
  page: 1,
  x: 72,
  y,
  size: 11,
  right: 72 + text.length * width,
  text,
});

const userLink = (login: string, from: number, to: number, y: number): PageLink => ({
  page: 1,
  url: `https://archiveofourown.org/users/${login}`,
  rect: [from, y - 2, to, y + 11],
});

const read = (lines: TextLine[], links: PageLink[]) =>
  readWork({
    lines: [posted, stats, title, ...lines],
    links,
    infoTitle: null,
    outline: [],
  });

describe("12-pdf-upload: the byline, on the parser's lines", () => {
  it("a narrow unlinked name beside a wide linked one is still named", () => {
    // "by jill, MARGARET WILLIAMSON": capitals print wide, so the link starts well past the middle.
    // As Helvetica at 11 pt sets it: "by jill, " is 32 pt wide, the capitals 146.
    const byline: TextLine = { ...line("by jill, MARGARET WILLIAMSON", 640), right: 72 + 178 };
    const work = read([byline, line("The text.", 610)], [userLink("mw", 72 + 32, 72 + 178, 640)]);
    expect(work.authors.map((a) => a.pseud)).toContain("jill");
    expect(work.reviewReasons).toContain("byline_ambiguous");
  });

  it("characters outside the basic plane don't shift where names are", () => {
    const flowers = "\u{1F338}".repeat(10);
    const first = line(`by ${flowers}, Mona,`, 640);
    const second = line("Second Author", 628);
    const work = read(
      [first, second, line("The text.", 600)],
      [
        userLink("flower", 72 + 3 * 5.5, 72 + 13 * 5.5, 640),
        userLink("sa", 72, 72 + 13 * 5.5, 628),
      ],
    );
    expect(work.authors.map((a) => a.pseud)).toContain("Mona");
  });

  it("a link with no pseud in it names the pseud printed under it", () => {
    const text = "by Opted Out, Other Name";
    const work = read(
      [line(text, 640), line("The text.", 610)],
      [
        userLink("login1", 72 + 3 * 5.5, 72 + 12 * 5.5, 640),
        userLink("login2", 72 + 14 * 5.5, 72 + 24 * 5.5, 640),
      ],
    );
    expect(work.authors).toEqual([
      { pseud: "Opted Out", user: "login1" },
      { pseud: "Other Name", user: "login2" },
    ]);
  });

  it("a long byline doesn't take the field line under it", () => {
    const text = "by One Name, Two Name, Three Name, Four Name, Five Name";
    const links = [3, 13, 23, 35, 46].map((at, i) =>
      userLink(`u${i}`, 72 + at * 5.5, 72 + (at + 9) * 5.5, 640),
    );
    // The fields come after the byline here, as they can.
    const work = readWork({
      lines: [
        posted,
        title,
        line(text, 640),
        line("Rating: Mature", 626),
        { ...stats, y: 612 },
        line("The text.", 590),
      ],
      links,
      infoTitle: null,
      outline: [],
    });
    expect(work.tags.rating).toEqual(["Mature"]);
  });

  it("a short-lined poem under the byline is the text, not the byline", () => {
    const poem = ["To Alice, Bob and the sea", "the tide", "and", "the shore"];
    const work = read(
      [line("by A Rather Long Pseud", 640), ...poem.map((p, i) => line(p, 626 - i * 14))],
      [userLink("rl", 72 + 3 * 5.5, 72 + 22 * 5.5, 640)],
    );
    expect(work.authors.map((a) => a.user)).toEqual(["rl"]);
    expect(work.chapters[0]!.paragraphs.join(" ")).toContain("the shore");
  });

  it("a line far under the byline with its link again isn't the byline", () => {
    const work = read(
      [
        line("by Someone", 640),
        line("More of my work is on my profile.", 606),
        line("The text.", 590),
      ],
      [userLink("someone", 72 + 3 * 5.5, 72 + 10 * 5.5, 640), userLink("someone", 72, 300, 606)],
    );
    expect(work.chapters[0]!.paragraphs.join(" ")).toContain("More of my work");
  });

  it("stays quick on a byline line of a million characters under fifty thousand links", () => {
    const long = { ...line(`by ${"x".repeat(1_000_000)}`, 640), right: 600 };
    const links = Array.from({ length: 50_000 }, (_, i) =>
      userLink(`u${i}`, 72 + (i % 500), 73 + (i % 500), 640),
    );
    const started = Date.now();
    read([long, line("The text.", 610)], links);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("12-pdf-upload: the end of the text, on the parser's lines", () => {
  const closing = line(
    "Please drop by the Archive and comment to let the creator know if you enjoyed their work!",
    0,
  );
  const ending = (rows: string[]) => {
    const lines = rows.map((text, i) => line(text, 600 - i * 20));
    return read(
      [line("by Someone", 640), ...lines, { ...closing, y: 600 - rows.length * 20 }],
      [userLink("someone", 72 + 3 * 5.5, 72 + 10 * 5.5, 640)],
    );
  };

  it("an Afterword line in the text, with more text under it, isn't the heading", () => {
    const work = ending(["Body.", "Afterword", "The epilogue goes on.", "And on."]);
    expect(work.chapters[0]!.paragraphs).toEqual([
      "Body.",
      "Afterword",
      "The epilogue goes on.",
      "And on.",
    ]);
  });

  it("the heading's notes keep a line of their own reading Afterword", () => {
    const work = ending(["Body.", "Afterword", "End Notes", "A note.", "Afterword"]);
    expect(work.chapters[0]!.paragraphs).toEqual(["Body."]);
    expect(work.endNotes).toEqual(["A note.", "Afterword"]);
  });
});

describe("12-pdf-upload: the printed work's link, on the parser's lines", () => {
  it("a link on the first line of the text, under the Posted line, isn't compared", () => {
    const work = readWork({
      lines: [
        stats,
        title,
        line("by Someone", 640),
        { ...posted, y: 620 },
        line("Read this one too.", 606),
      ],
      links: [
        userLink("someone", 72 + 3 * 5.5, 72 + 10 * 5.5, 640),
        { page: 1, url: "https://archiveofourown.org/works/8813740", rect: [72, 618, 500, 631] },
        { page: 1, url: "https://archiveofourown.org/works/999", rect: [72, 604, 200, 617] },
      ],
      infoTitle: null,
      outline: [],
    });
    expect(work.reviewReasons.some((r) => r.startsWith("work_id_mismatch"))).toBe(false);
  });
});
