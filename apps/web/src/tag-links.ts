import type { TagType } from "@archive/db";

// The one URL builder for tag pages, shared by the work page and the tag listing:
// `/tags/<type>/<name_norm>`, so the same name as a fandom and as a character are
// two pages. Both parts are percent-encoded, which also makes the href safe to quote.
export function tagHref(type: string, nameNorm: string): string {
  return "/tags/" + encodeURIComponent(type) + "/" + encodeURIComponent(nameNorm);
}

/** The types shown as links, each with the hidden label that announces it. */
export type LinkedType = Exclude<TagType, "rating" | "warning">;

// The type is announced, never shown by colour (FRONTEND-DISCOVERY, Components,
// Tag list). Rating and warnings are plain text on their own line instead. The
// listing's filter form names the types the same way.
export const TAG_LABELS: Record<LinkedType, string> = {
  fandom: "Fandom",
  category: "Category",
  relationship: "Relationship",
  character: "Character",
  freeform: "Additional tag",
};

/** Every type's name, for a tag listing's heading ("Sherlock Holmes (fandom)"), lower-cased there. */
export const TAG_NAMES: Record<TagType, string> = {
  ...TAG_LABELS,
  rating: "Rating",
  warning: "Warning",
};
