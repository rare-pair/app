import { countWords, LIMITS, nodeBudget, sanitizeFragment, type ParsedWork } from "@archive/epub";
import { preflightPdf } from "./preflight";
import { readWork, type PdfText } from "./structure";

/** The heavy part of the PDF processor, loaded only for a PDF. */
export interface PdfParser {
  read: (bytes: Uint8Array) => Promise<PdfText>;
}

export type LoadPdfParser = () => Promise<PdfParser>;

/** A PDF's largest size. An epub keeps `LIMITS.maxInputBytes`. */
export const PDF_MAX_BYTES = LIMITS.maxPdfBytes;

/** Whether the file's bytes call for the PDF processor. */
export const isPdf = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

/** Plain text as markup: nothing from the file becomes a tag. */
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A PDF's bytes in, a parsed work out, or an `EpubError`. */
export async function processPdf(bytes: Uint8Array, load: LoadPdfParser): Promise<ParsedWork> {
  preflightPdf(bytes);
  const parser = await load();
  const work = readWork(await parser.read(bytes));
  // One budget for the work, as an epub has: the HTML is written here and sanitized the same way.
  const budget = nodeBudget();
  const html = async (paragraphs: string[]): Promise<string | null> => {
    if (paragraphs.length === 0) return null;
    const markup = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
    return (await sanitizeFragment(markup, budget)).trim();
  };
  const chapters = [];
  for (const [i, chapter] of work.chapters.entries()) {
    const body = (await html(chapter.paragraphs)) ?? "";
    chapters.push({ n: i + 1, title: chapter.title, html: body, words: countWords(body) });
  }
  return {
    ao3WorkId: work.ao3WorkId,
    title: work.title,
    authors: work.authors,
    rating: work.tags.rating[0] ?? null,
    warnings: work.tags.warnings,
    categories: work.tags.categories,
    fandoms: work.tags.fandoms,
    relationships: work.tags.relationships,
    characters: work.tags.characters,
    freeforms: work.tags.freeforms,
    language: work.language,
    series: work.series,
    stats: work.stats,
    summaryHtml: await html(work.summary),
    notesHtml: await html(work.notes),
    endNotesHtml: await html(work.endNotes),
    chapters,
    images: [],
    rawMeta: work.rawMeta,
    reviewReasons: work.reviewReasons,
  };
}
