// Writes the committed synthetic fixtures in fixtures/epubs/synthetic/: AO3-shaped
// epubs with numbered filler text, and their expected.json. They stand in for the
// real, git-ignored fixtures so fixtures.test.ts runs everywhere, CI included.
// Run from the repo root: npm run fixtures:synthetic -w @archive/epub
// The output is byte-for-byte the same on every run; commit it with any change here.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ao3Epub, type Ao3Spec } from "../test/build.ts";
import type { Expected } from "../test/expected.ts";

const OUT_DIR = fileURLToPath(new URL("../../../fixtures/epubs/synthetic/", import.meta.url));

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Words as countWords sees them in plain text: runs with a letter or digit. */
const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** `paragraphs` paragraphs of five numbered sentences each, starting at sentence `from`. */
function filler(label: string, paragraphs: number, from = 1): string[] {
  return Array.from({ length: paragraphs }, (_, p) =>
    Array.from(
      { length: 5 },
      (_, s) => `Sentence ${from + p * 5 + s} of the ${label}, filler text with no meaning.`,
    ).join(" "),
  );
}

const paras = (texts: string[], attrs = "") =>
  texts.map((t) => `<p class="calibre7"${attrs}>${t}</p>`).join("\n");

const chapterRegion = (inner: string) => `<div id="chapters" class="userstuff1">${inner}</div>`;

const tags = (label: string, values: string[]) =>
  `<dt class="calibre3">${label}:</dt><dd class="calibre4">${values
    .map((v, i) => `<a href="http://archiveofourown.org/tags/${label}${i}">${v}</a>`)
    .join(", ")}</dd>`;

interface Fixture {
  name: string;
  spec: Ao3Spec;
  expected?: Expected;
}

/** A one-shot shaped for the per-entry checks in fixtures.test.ts. */
function oneShot(opts: {
  name: string;
  workId: number;
  title: string;
  published: string;
  byline?: string;
  authors: Expected["authors"];
  relationships: string[];
  characters: string[];
}): Fixture {
  const text = filler(`synthetic one-shot ${opts.workId}`, 8);
  const words = wordCount(text.join(" "));
  const extraDl = [
    tags("Category", ["M/M"]),
    opts.relationships.length > 0 ? tags("Relationship", opts.relationships) : "",
    tags("Characters", opts.characters),
  ].join("\n    ");
  // Sanitized, the chapter opens with `<div><p>`, then the first sentence.
  const opening = text[0]!.slice(0, 40);
  const expected: Expected = {
    workIdSha: sha(String(opts.workId)),
    titleSha: sha(opts.title),
    authors: opts.authors,
    rating: "General Audiences",
    fandomShas: [sha("Test Fandom")],
    relationships: opts.relationships.length,
    characters: opts.characters.length,
    freeforms: 2,
    words,
    published: opts.published,
    opening: { offset: "<div><p>".length, length: opening.length, sha: sha(opening) },
  };
  if (opts.relationships[0]) expected.relationshipIncludesSha = sha(opts.relationships[0]);
  return {
    name: opts.name,
    spec: {
      workId: opts.workId,
      title: opts.title,
      byline: opts.byline,
      extraDl,
      stats: `Published: ${opts.published} Chapters: 1/1 Words: ${words}`,
      files: [
        {
          name: `${opts.title}_split_001.xhtml`,
          body: chapterRegion(
            `<h2 class="toc-heading" id="calibre_toc_3">${opts.title}</h2>
<div class="userstuff2">${paras(text)}</div>`,
          ),
        },
      ],
    },
    expected,
  };
}

const multi = filler("synthetic multi-chapter work", 9);
const pictures = filler("synthetic picture work", 2);
const rtl = Array.from({ length: 6 }, (_, p) =>
  Array.from({ length: 5 }, (_, s) => `الجملة رقم ${p * 5 + s + 1} نص تجريبي بلا معنى.`).join(" "),
);

const FIXTURES: Fixture[] = [
  oneShot({
    name: "synthetic-one-shot-01.epub",
    workId: 1000101,
    title: "Synthetic One-Shot One",
    published: "2020-03-04",
    authors: [{ pseudSha: sha("someone"), userSha: sha("someone") }],
    relationships: ["Char One/Char Two"],
    characters: ["Char One", "Char Two"],
  }),
  oneShot({
    name: "synthetic-one-shot-02-anonymous.epub",
    workId: 1000102,
    title: "Synthetic One-Shot Two",
    published: "2021-07-08",
    byline: "Anonymous",
    authors: [{ pseudSha: sha("Anonymous"), userSha: null }],
    relationships: [],
    characters: ["Char Three"],
  }),
  {
    // Three chapters over two files, the second split across both; a series member.
    name: "synthetic-multi-chapter-01.epub",
    spec: {
      workId: 1000103,
      title: "Synthetic Multi-Chapter",
      stats: `Published: 2022-01-02 Completed: 2022-03-04 Chapters: 3/3 Words: ${wordCount(multi.join(" "))}`,
      extraDl: `${tags("Category", ["Gen"])}
    <dt class="calibre3">Series:</dt><dd class="calibre4">Part 2 of <a href="http://archiveofourown.org/series/2000101">Synthetic Series</a></dd>`,
      files: [
        {
          name: "Synthetic Multi-Chapter_split_001.xhtml",
          body: chapterRegion(`<h2 class="toc-heading" id="c1">Chapter 1: First</h2>
<div class="userstuff2">${paras(multi.slice(0, 3))}</div>
<h2 class="toc-heading" id="c2">Chapter 2: Second</h2>
<div class="userstuff2">${paras(multi.slice(3, 5))}</div>`),
        },
        {
          name: "Synthetic Multi-Chapter_split_002.xhtml",
          body: chapterRegion(`<div class="userstuff2">${paras(multi.slice(5, 6))}</div>
<h2 class="toc-heading" id="c3">Chapter 3: Third</h2>
<div class="userstuff2">${paras(multi.slice(6))}</div>`),
        },
      ],
      navPoints: [
        { label: "1. First", src: "Synthetic%20Multi-Chapter_split_001.xhtml#c1" },
        { label: "2. Second", src: "Synthetic%20Multi-Chapter_split_001.xhtml#c2" },
        { label: "3. Third", src: "Synthetic%20Multi-Chapter_split_002.xhtml#c3" },
      ],
    },
  },
  {
    // A one-shot with an image in the manifest.
    name: "synthetic-images-01.epub",
    spec: {
      workId: 1000104,
      title: "Synthetic Pictures",
      stats: `Published: 2023-05-06 Chapters: 1/1 Words: ${wordCount(pictures.join(" "))}`,
      files: [
        {
          name: "Synthetic Pictures_split_001.xhtml",
          body: chapterRegion(`<h2 class="toc-heading">Synthetic Pictures</h2>
<div class="userstuff2">${paras(pictures.slice(0, 1))}
<p class="calibre7"><img src="images/figure%201.png" alt="A synthetic figure" class="calibre8"/></p>
${paras(pictures.slice(1))}</div>`),
        },
      ],
      extraManifest: [{ href: "images/figure%201.png", mediaType: "image/png", data: PNG }],
    },
  },
  {
    // Right-to-left, non-English text.
    name: "synthetic-rtl-01.epub",
    spec: {
      workId: 1000105,
      title: "عمل تجريبي",
      language: "العربية",
      stats: `Published: 2024-09-10 Chapters: 1/1 Words: ${wordCount(rtl.join(" "))}`,
      summary: '<p dir="rtl" lang="ar">ملخص تجريبي.</p>',
      files: [
        {
          name: "rtl_split_001.xhtml",
          body: chapterRegion(`<h2 class="toc-heading">عمل تجريبي</h2>
<div class="userstuff2" dir="rtl">${paras(rtl, ' dir="rtl" lang="ar"')}</div>`),
        },
      ],
    },
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const expected: Record<string, Expected> = {};
for (const f of FIXTURES) {
  writeFileSync(`${OUT_DIR}${f.name}`, ao3Epub(f.spec));
  if (f.expected) expected[f.name] = f.expected;
}
writeFileSync(`${OUT_DIR}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(`Wrote ${FIXTURES.length} fixtures to ${OUT_DIR}`);
