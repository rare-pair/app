// What moderators read for the reason codes a PDF's version carries. Other codes hold details from
// the parser, and read as they are.

const WORDING = new Map([
  ["from_pdf", "Converted from a PDF"],
  ["tags_from_print", "Tags read from print"],
  ["pdf_more_chapters", "A PDF with more chapters than the current epub"],
]);

/** A review or hold reason, in words where it has them. */
export const reasonWording = (reason: string): string => WORDING.get(reason) ?? reason;
