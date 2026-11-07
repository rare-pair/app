import {
  countWords,
  EpubError,
  LIMITS,
  nodeBudget,
  sanitizeFragment,
  type ParsedWork,
} from "@archive/epub";
import { preflightPdf } from "./preflight";
import { readWork, type PdfText } from "./structure";

/** The heavy part of the PDF processor, loaded only for a PDF. */
export interface PdfParser {
  read: (bytes: Uint8Array) => Promise<PdfText>;
}

export type LoadPdfParser = () => Promise<PdfParser>;

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

/**
 * Runs a step that does no I/O of its own, on the file's bytes alone: what it throws it would throw
 * every time, so it's a final refusal, not a job to retry. A stack overflow, say.
 */
async function final<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (cause) {
    if (cause instanceof EpubError) throw cause;
    throw new EpubError("pdf_unreadable", "The file couldn't be read", { cause });
  }
}

/** A PDF's bytes in, a parsed work out, or an `EpubError`. */
export async function processPdf(bytes: Uint8Array, load: LoadPdfParser): Promise<ParsedWork> {
  // By the bytes: the web Worker checks the size against what the file was sent as, which can lie.
  if (bytes.length > LIMITS.maxPdfBytes) {
    throw new EpubError("too_large", `File is larger than ${LIMITS.maxPdfBytes} bytes`);
  }
  const parser = await final(async () => {
    preflightPdf(bytes);
    return load();
  });
  const text = await parser.read(bytes);
  const work = await final(async () => readWork(text));
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
