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
  },
];

function scriptEpub(s: Script): Uint8Array {
  const name = "Synthetic_split_001.xhtml";
  const p = (text: string) => `<p ${s.attrs}>${text}</p>`;
  return ao3Epub({
    title: s.title,
    extraDl: `<dt>Language:</dt><dd>${s.language}</dd>`,
    summary: p(s.summary),
    notes: p(s.notes),
    endNotes: p(s.endNotes),
    files: [
      {
        name,
        body: `<div id="chapters"><div class="userstuff2">${p(s.chapter)}</div></div>`,
      },
    ],
    navPoints: [{ label: s.chapterTitle, src: encodeURI(name) }],
  });
}

describe("06-ao3-preface-and-chapters", () => {
  it("Right-to-left and non-English text survive parsing", async () => {
    for (const s of scripts) {
      const epub = scriptEpub(s);
      const work = await processEpub(epub.slice());
      const p = (text: string) => `<p ${s.attrs}>${text}</p>`;

      expect(work.title, s.name).toBe(s.title);
      expect(work.language, s.name).toBe(s.language);
      expect(work.summaryHtml, s.name).toContain(p(s.summary));
      expect(work.notesHtml, s.name).toContain(p(s.notes));
      expect(work.endNotesHtml, s.name).toContain(p(s.endNotes));
      expect(work.chapters, s.name).toHaveLength(1);
      expect(work.chapters[0]?.title, s.name).toBe(s.chapterTitle);
      expect(work.chapters[0]?.html, s.name).toContain(p(s.chapter));
      expect(work.chapters[0]?.words, s.name).toBeGreaterThan(0);
      expect(work.reviewReasons, s.name).toEqual([]);

      const html = [work.summaryHtml, work.notesHtml, work.endNotesHtml, work.chapters[0]?.html];
      for (const part of html) {
        expect(part, s.name).not.toContain("xml:lang");
        expect(part, s.name).not.toContain("class=");
      }

      expect(await processEpub(epub.slice()), s.name).toEqual(work);
    }
  });
});
