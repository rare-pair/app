import { describe, expect, it } from "vitest";
import { processEpub } from "../src";
import { ao3Epub } from "./helpers";

// Generated epubs with sentences we invented: no fanwork text. The helper only takes an ASCII
// pseud, so the author name stays out of these assertions. The parser reads the language from the
// preface's `Language:` label (a display name, not a code) and keeps the source's `dir` and `lang`
// attributes in sanitized HTML; it derives neither.

interface Script {
  name: string;
  language: string;
  title: string;
  chapterTitle: string;
  summary: string;
  notes: string;
  endNotes: string;
  chapter: string;
  /** The attributes the source markup carries, kept verbatim. */
  attrs: string;
  lang: string;
  /** Words in `chapter`: split on spaces for Arabic and Hebrew, one per character for Japanese. */
  words: number;
}

const scripts: Script[] = [
  {
    name: "Arabic",
    language: "العربية",
    title: "قصة اختبار قصيرة",
    chapterTitle: "الفصل الأول",
    summary: "ملخص قصير مكتوب للاختبار.",
    notes: "ملاحظات قصيرة قبل الفصل.",
    endNotes: "ملاحظات ختامية قصيرة.",
    chapter: "كتبنا هذه الجملة للاختبار فقط.",
    attrs: 'dir="rtl" lang="ar"',
    lang: "ar",
    words: 5,
  },
  {
    name: "Hebrew",
    language: "עברית",
    title: "סיפור בדיקה קצר",
    chapterTitle: "פרק ראשון",
    summary: "תקציר קצר שנכתב לבדיקה.",
    notes: "הערות קצרות לפני הפרק.",
    endNotes: "הערות סיום קצרות.",
    chapter: "כתבנו את המשפט הזה לבדיקה בלבד.",
    attrs: 'dir="rtl" lang="he"',
    lang: "he",
    words: 6,
  },
  {
    name: "Japanese",
    language: "日本語",
    title: "短いテスト作品",
    chapterTitle: "第一章",
    summary: "テスト用に書いた短いあらすじ。",
    notes: "本文の前の短い注記。",
    endNotes: "短い後書き。",
    chapter: "これはテストのためだけに書いた文です。",
    attrs: 'dir="ltr" lang="ja"',
    lang: "ja",
    words: 18,
  },
];

/** The paragraph the source carries: the sanitizer must strip its `class` and `xml:lang`. */
const sourceP = (s: Script, text: string) =>
  `<p class="calibre7" xml:lang="${s.lang}" ${s.attrs}>${text}</p>`;
/** The paragraph that should come out. */
const keptP = (s: Script, text: string) => `<p ${s.attrs}>${text}</p>`;

function scriptEpub(s: Script): Uint8Array {
  const name = "Synthetic_split_001.xhtml";
  return ao3Epub({
    title: s.title,
    extraDl: `<dt>Language:</dt><dd>${s.language}</dd>`,
    summary: sourceP(s, s.summary),
    notes: sourceP(s, s.notes),
    endNotes: sourceP(s, s.endNotes),
    files: [
      {
        name,
        body: `<div id="chapters"><div class="userstuff2">${sourceP(s, s.chapter)}</div></div>`,
      },
    ],
    navPoints: [{ label: s.chapterTitle, src: encodeURI(name) }],
  });
}

describe("06-ao3-preface-and-chapters", () => {
  it.each(scripts)("Right-to-left and non-English text survive parsing: $name", async (s) => {
    const epub = scriptEpub(s);
    const work = await processEpub(epub.slice());

    expect(work.title).toBe(s.title);
    expect(work.language).toBe(s.language);
    expect(work.summaryHtml).toContain(keptP(s, s.summary));
    expect(work.notesHtml).toContain(keptP(s, s.notes));
    expect(work.endNotesHtml).toContain(keptP(s, s.endNotes));
    expect(work.chapters).toHaveLength(1);
    expect(work.chapters[0]?.title).toBe(s.chapterTitle);
    expect(work.chapters[0]?.html).toContain(keptP(s, s.chapter));
    expect(work.chapters[0]?.words).toBe(s.words);
    expect(work.reviewReasons).toEqual([]);

    const html = [work.summaryHtml, work.notesHtml, work.endNotesHtml, work.chapters[0]?.html];
    for (const part of html) {
      expect(part).not.toContain("xml:lang");
      expect(part).not.toContain("class=");
    }

    expect(await processEpub(epub.slice())).toEqual(work);
  });
});
