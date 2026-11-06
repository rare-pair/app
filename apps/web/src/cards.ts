// Link preview cards: Open Graph tags plus `twitter:card`, as raw markup for a page's
// `head` (pages.ts, `layout`). Opt-in: a page that isn't passed a card has none, so
// chapters, withheld works, token pages and admin pages are card-free by construction.
// A card is text only (no image) and holds no summary (FRONTEND-DISCOVERY, Link cards).
// It is built from named fields, never from the request, so no token or query reaches it.

import { escapeHtml } from "./pages";
import { SITE } from "./signin";

const SITE_NAME = "rarepair";
const SITE_DESCRIPTION = "An unofficial, temporary, community-run reading archive for fanworks.";

const meta = (attribute: "property" | "name", key: string, content: string) =>
  `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`;

const card = (type: "website" | "article", title: string, description: string, url?: string) =>
  [
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    meta("property", "og:site_name", SITE_NAME),
    meta("property", "og:type", type),
    ...(url === undefined ? [] : [meta("property", "og:url", url)]),
    meta("name", "twitter:card", "summary"),
  ].join("");

/** The card the public pages that aren't a work share. */
export const siteCard = () => card("website", SITE_NAME, SITE_DESCRIPTION);

export type WorkCardFields = {
  ao3WorkId: number;
  title: string;
  /** Raw pseuds in byline order; none for a work stored without an author. */
  pseuds: string[];
  rating: string | null;
  warnings: string[];
  fandoms: string[];
};

/**
 * A work's card. The description runs byline, rating, warnings, fandoms, so a sharing
 * site that clips it loses the least important part first. Values are raw: escaped here.
 */
export const workCard = (work: WorkCardFields) => {
  const byline = work.pseuds.filter((pseud) => pseud.trim() !== "").join(", ");
  const rating = (work.rating ?? "").trim();
  return card(
    "article",
    work.title.trim() === "" ? "Untitled work" : work.title,
    [
      `by ${byline === "" ? "Anonymous" : byline}`,
      rating === "" ? "Not Rated" : rating,
      ...[work.warnings, work.fandoms].flatMap((names) =>
        names.length > 0 ? names.join(", ") : [],
      ),
    ].join(" · "),
    `${SITE}/works/${work.ao3WorkId}`,
  );
};
