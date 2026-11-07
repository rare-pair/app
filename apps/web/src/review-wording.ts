// What moderators read for the reason codes a PDF's version carries. Other codes hold details from
// the parser, and read as they are.

const WORDING = new Map([
  ["from_pdf", "Converted from a PDF"],
  ["tags_from_print", "Tags read from print"],
  ["pdf_more_chapters", "A PDF with more chapters than the current epub"],
  ["pdf_byline_unsure", "A PDF whose byline may not have been read whole: check its authors"],
  ["byline_unsure", "Byline may not have been read whole"],
]);

/** The hold reasons with wording a moderator reads in the queue. */
export const WORDED_HOLDS = ["pdf_byline_unsure", "pdf_more_chapters"];

/** A review or hold reason, in words where it has them. */
export const reasonWording = (reason: string): string => WORDING.get(reason) ?? reason;
