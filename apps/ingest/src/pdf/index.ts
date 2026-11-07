import type { ParsedWork } from "@archive/epub";
import { preflightPdf } from "./preflight";

/** The heavy part of the PDF processor, loaded only for a PDF. */
export interface PdfParser {
  parse: (bytes: Uint8Array) => Promise<ParsedWork>;
}

export type LoadPdfParser = () => Promise<PdfParser>;

/** Whether the file's bytes call for the PDF processor. */
export const isPdf = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

/** A PDF's bytes in, a parsed work out, or an `EpubError`. */
export async function processPdf(bytes: Uint8Array, load: LoadPdfParser): Promise<ParsedWork> {
  preflightPdf(bytes);
  const parser = await load();
  return parser.parse(bytes);
}
