// The one module that loads `unpdf`, by `import()` from the Worker: an epub's job never does.
import { EpubError } from "@archive/epub";
import { getDocumentProxy, resolvePDFJSImports } from "unpdf";
import type { PdfParser } from "./index";
import { PDF_LIMITS } from "./limits";
import type { PageLink, PdfText, TextLine } from "./structure";

// Pages between yields: enough for the lease's timer to fire, without a timer per page, which
// costs far more wall time than the parse (65 s against 11 s on a 4,252-page file).
const YIELD_PAGES = 16;

const MAX_LINE = 8 * 1024;

const AO3_LINK = /^https?:\/\/(?:www\.|download\.)?archiveofourown\.org\//i;

const yieldToTimers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One text item of pdf.js's text content, as far as it's read here. */
interface TextItem {
  str?: string;
  transform?: number[];
  width?: number;
}

/** The outline's entries in order, for those it can place; none when it's too long to be real. */
async function readOutline(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<PdfText["outline"]> {
  const entries: { title: string; dest: unknown }[] = [];
  const walk = (items: unknown[]): void => {
    // SAFETY: the shape pdf.js gives an outline's entries.
    for (const item of items as { title: string; dest: unknown; items?: unknown[] }[]) {
      entries.push({ title: item.title, dest: item.dest });
      if (entries.length > PDF_LIMITS.maxPages) return;
      walk(item.items ?? []);
    }
  };
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- null for no outline, whatever its type says
  walk((await pdf.getOutline()) ?? []);
  if (entries.length > PDF_LIMITS.maxPages) return [];
  const outline: PdfText["outline"] = [];
  for (const entry of entries) {
    // oxlint-disable-next-line deslop/no-runtime-typeof -- a named or an explicit destination
    const dest = typeof entry.dest === "string" ? await pdf.getDestination(entry.dest) : entry.dest;
    if (!Array.isArray(dest)) return [];
    const target = dest[0];
    // oxlint-disable-next-line deslop/no-runtime-typeof -- an index, or a page's reference
    const index = typeof target === "number" ? target : await pdf.getPageIndex(target);
    const y = dest[3];
    // oxlint-disable-next-line deslop/no-runtime-typeof -- a height, or null for the page's top
    outline.push({ title: entry.title, page: index + 1, y: typeof y === "number" ? y : Infinity });
  }
  return outline;
}

/**
 * Reads the file's text and links, page by page, within the limits. pdf.js takes the buffer it's
 * given, so it gets a copy, and it's released before the chapters are built.
 */
async function readText(bytes: Uint8Array): Promise<PdfText> {
  // SAFETY: pdf.js takes these options; unpdf's type names only some of them.
  const options = { useSystemFonts: false, disableFontFace: true, verbosity: 0 } as Parameters<
    typeof getDocumentProxy
  >[1];
  const pdf = await getDocumentProxy(bytes.slice(), options);
  try {
    if (pdf.numPages > PDF_LIMITS.maxPages) {
      throw new EpubError("pdf_unreadable", "More pages than a file may have");
    }
    const lines: TextLine[] = [];
    const links: PageLink[] = [];
    let items = 0;
    let chars = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      for (const annotation of await page.getAnnotations()) {
        // Only links to the original archive are read, so only those are kept.
        if (annotation.subtype === "Link" && AO3_LINK.test(annotation.url ?? "")) {
          links.push({ page: n, url: annotation.url, rect: annotation.rect });
        }
      }
      if (links.length > PDF_LIMITS.maxLinks) {
        throw new EpubError("pdf_unreadable", "More links than a file may hold");
      }
      const reader = page.streamTextContent().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // SAFETY: the fields of a text item; a marked-content item has none, and is skipped below.
        for (const item of value.items as TextItem[]) {
          items++;
          const text = item.str ?? "";
          if (text === "" || !item.transform) continue;
          chars += text.length;
          const [, , c = 0, d = 0, x = 0, y = 0] = item.transform;
          const right = x + (item.width ?? 0);
          const last = lines.at(-1);
          // Bounded: a real line is a few hundred characters, and later patterns read them.
          if (last && last.page === n && Math.abs(last.y - y) < 2 && last.text.length < MAX_LINE) {
            last.text += text;
            last.right = Math.max(last.right, right);
          } else {
            lines.push({ page: n, x, y, size: Math.hypot(c, d), right, text });
          }
        }
        if (items > PDF_LIMITS.maxTextItems || chars > PDF_LIMITS.maxTextChars) {
          // Not waited for: pdf.js may never settle it, once a page's text has all been sent.
          reader.cancel(new Error("over the limit")).catch(() => undefined);
          throw new EpubError("pdf_unreadable", "More text than a file may hold");
        }
      }
      page.cleanup();
      if (n % YIELD_PAGES === 0) await yieldToTimers();
    }
    // Only a file with no chapter headings needs it, so a broken one refuses nothing by itself.
    const outline = await readOutline(pdf).catch(() => []);
    const { info } = await pdf.getMetadata();
    // SAFETY: the one field read, of what the file says of itself, and its type is checked below.
    const infoTitle = (info as { Title?: unknown }).Title;
    return {
      lines,
      links,
      // oxlint-disable-next-line deslop/no-runtime-typeof -- metadata comes from the file
      infoTitle: typeof infoTitle === "string" ? infoTitle : null,
      outline,
    };
  } finally {
    await pdf.destroy();
  }
}

/** The parser. Anything pdf.js throws on these bytes it throws every time, so it's final. */
export const pdfParser = (): PdfParser => ({
  read: async (bytes) => {
    // Outside the try: failing to load is no verdict on the file, and is worth a retry.
    await resolvePDFJSImports(() => import("unpdf/pdfjs"));
    try {
      return await readText(bytes);
    } catch (cause) {
      if (cause instanceof EpubError) throw cause;
      throw new EpubError("pdf_unreadable", "The parser couldn't read this file", { cause });
    }
  },
});
