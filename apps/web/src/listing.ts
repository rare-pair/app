// The tag listing, `/tags/:type/:name`: a tag's live works as work cards
// (FRONTEND-DISCOVERY, Components, Work card), a page at a time, with page
// links that are real links (FRONTEND-DISCOVERY, Pagination).

import {
  createDb,
  isTagType,
  listLiveWorksByTag,
  liveTagSpellings,
  NOT_RATED,
  tagNameKeys,
  type ListedWork,
  type ListingSort,
  type TagType,
} from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { escapeHtml, layout } from "./pages";
import { TAG_LABELS, tagHref } from "./tag-links";

const WORDS = new Intl.NumberFormat("en-US");

/** Works per page. */
const PAGE_SIZE = 20;

/**
 * A listing's short cache (14 and 19, "Listings are briefly cached"), on a 200 only.
 * `private`, so a page that shows anything of one reader's cookies stays in their
 * browser. With hidden and removed works, that means a browser can show a work's
 * card for up to two minutes after it leaves, beyond Hyperdrive's own cache (#233).
 */
const CACHED = { "Cache-Control": "private, max-age=60, stale-while-revalidate=60" };

/** The pages either side of the current one that the pager links, besides the first and last. */
const PAGES_AROUND = 2;

/**
 * The page asked for. Anything but digits is the first page, as is 0. Digits
 * too many for a safe integer stay a number past every last page.
 */
const pageOf = (raw: string | undefined) =>
  raw !== undefined && /^\d+$/.test(raw) ? Math.max(1, Number(raw)) : 1;

/** The sort and filters a listing is shown with: what its URL asks for, less anything unknown. */
interface ListingQuery {
  sort: ListingSort;
  /** Absent for any rating. */
  rating?: string;
  /** As the URL spells it; absent for complete works and works in progress alike. */
  complete?: "yes" | "no";
  /** A second tag the works must carry, as typed. Absent for none. */
  tag?: { type: NarrowingType; name: string };
}

/** A query parameter, or a select's option: a value and its text. */
type Pair = [string, string];

/** The types a listing can be narrowed by, the first the form's default. */
const NARROWING_TYPES = ["freeform", "fandom", "relationship", "character"] as const;
type NarrowingType = (typeof NARROWING_TYPES)[number];

const SORTS: Record<ListingSort, string> = { updated: "Updated date", words: "Word count" };

/** The ratings a work card shows; a work with none shows as "Not Rated". */
const RATINGS = ["General Audiences", "Teen And Up Audiences", "Mature", "Explicit", NOT_RATED];

const isSort = (raw: string | undefined): raw is ListingSort =>
  raw !== undefined && Object.hasOwn(SORTS, raw);

/** The query string's sort and filters. A value the form can't send falls back to the default. */
function queryOf(raw: Record<string, string>): ListingQuery {
  const query: ListingQuery = { sort: isSort(raw.sort) ? raw.sort : "updated" };
  if (raw.rating !== undefined && RATINGS.includes(raw.rating)) query.rating = raw.rating;
  if (raw.complete === "yes" || raw.complete === "no") query.complete = raw.complete;
  const tagType = NARROWING_TYPES.find((t) => t === raw.tag_type) ?? NARROWING_TYPES[0];
  // A tag that names nothing (it folds to nothing, or holds a NUL) narrows nothing.
  if (raw.tag !== undefined && tagNameKeys(tagType, raw.tag).length > 0) {
    query.tag = { type: tagType, name: raw.tag };
  }
  return query;
}

/**
 * The query's parameters that differ from the defaults, in a fixed order, then
 * the page past the first. `tagName` is the narrowing tag's name as the URL
 * should carry it: as typed, or folded for the canonical URL.
 */
function paramsOf(query: ListingQuery, page: number, tagName = query.tag?.name): Pair[] {
  const params: Pair[] = [];
  if (query.sort !== "updated") params.push(["sort", query.sort]);
  if (query.rating !== undefined) params.push(["rating", query.rating]);
  if (query.complete !== undefined) params.push(["complete", query.complete]);
  if (query.tag !== undefined && tagName !== undefined) {
    params.push(["tag", tagName], ["tag_type", query.tag.type]);
  }
  if (page !== 1) params.push(["page", String(page)]);
  return params;
}

export async function showTagListing(c: Context<{ Bindings: Bindings }>) {
  const type = c.req.param("type");
  const name = c.req.param("name");
  if (type === undefined || name === undefined || !isTagType(type)) return c.notFound();
  const [nameNorm] = tagNameKeys(type, name);
  if (nameNorm === undefined) return c.notFound();
  const page = pageOf(c.req.query("page"));
  const query = queryOf(c.req.query());
  // A few queries, one after another, on one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // The heading comes from every live work with the tag, so no page or filter changes it.
    const [heading] = await liveTagSpellings(db, type, name);
    if (heading === undefined) {
      // A fixed heading: a tag only hidden or removed works use reads like one
      // nobody has used, and the page repeats nothing from its URL.
      return page === 1
        ? c.html(
            layout("No works with this tag", "<p>No works have this tag yet.</p>"),
            200,
            CACHED,
          )
        : c.notFound();
    }
    const { works, total } = await listLiveWorksByTag(db, type, name, {
      ...query,
      complete: query.complete === undefined ? undefined : query.complete === "yes",
      page,
      pageSize: PAGE_SIZE,
    });
    const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > last) return c.notFound();
    const href = (n: number) => listingHref(type, name, paramsOf(query, n));
    const list =
      works.length === 0
        ? "<p>No works match these filters.</p>"
        : `<ol class="work-list" role="list">\n${works.map(workCard).join("\n")}\n</ol>`;
    // Spellings of the tags share one canonical page: their folded names, with no
    // redirect, since folding a folded name again can change it.
    const tagNorm = query.tag && tagNameKeys(query.tag.type, query.tag.name)[0];
    const canonical = `<link rel="canonical" href="${listingHref(type, nameNorm, paramsOf(query, page, tagNorm))}">`;
    return c.html(
      layout(
        heading,
        `${filterForm(listingHref(type, name, []), query)}\n${list}\n${pager(href, page, last)}`,
        canonical,
      ),
      200,
      CACHED,
    );
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}

/** A labelled select, with the option whose value is `chosen` selected. */
const select = (id: string, name: string, label: string, options: Pair[], chosen: string) =>
  `<p><label for="${id}">${label}</label> <select id="${id}" name="${name}">${options
    .map(
      ([value, text]) =>
        `<option value="${escapeHtml(value)}"${value === chosen ? " selected" : ""}>${escapeHtml(text)}</option>`,
    )
    .join("")}</select></p>`;

/**
 * The sort and filters as a GET form to the listing itself, with the current
 * choices selected, so it works with JavaScript off and the choices land in the URL.
 */
function filterForm(action: string, query: ListingQuery): string {
  const tagTypes = NARROWING_TYPES.map((t): Pair => [t, TAG_LABELS[t]]);
  return `<form class="listing-filters" method="get" action="${action}">
${select("listing-sort", "sort", "Sort by", Object.entries(SORTS), query.sort)}
${select("listing-rating", "rating", "Rating", [["", "Any"], ...RATINGS.map((r): Pair => [r, r])], query.rating ?? "")}
${select(
  "listing-complete",
  "complete",
  "Completion",
  [
    ["", "Any"],
    ["yes", "Complete"],
    ["no", "In progress"],
  ],
  query.complete ?? "",
)}
<p><label for="listing-tag">With the tag</label> <input id="listing-tag" name="tag" type="text" value="${escapeHtml(query.tag?.name ?? "")}"></p>
${select("listing-tag-type", "tag_type", "Tag type", tagTypes, query.tag?.type ?? NARROWING_TYPES[0])}
<p><button type="submit">Apply</button></p>
</form>`;
}

/** The listing's URL with these parameters, escaped for an attribute. */
function listingHref(type: TagType, name: string, params: Pair[]): string {
  const query = new URLSearchParams(params).toString();
  return escapeHtml(tagHref(type, name) + (query ? `?${query}` : ""));
}

/**
 * Previous, the page numbers and next, all real links; the current page is
 * marked and not a link. Page numbers are the first, the last and those within
 * PAGES_AROUND of the current one, with a gap shown between runs.
 */
function pager(href: (n: number) => string, page: number, last: number): string {
  if (last === 1) return "";
  const numbers = [
    ...new Set([
      1,
      last,
      ...Array.from({ length: 2 * PAGES_AROUND + 1 }, (_, i) => page - PAGES_AROUND + i),
    ]),
  ]
    .filter((n) => n >= 1 && n <= last)
    .sort((a, b) => a - b);
  const items = numbers.flatMap((n, i) => [
    ...(i > 0 && n - (numbers[i - 1] ?? n) > 1 ? ['<li aria-hidden="true">…</li>'] : []),
    n === page
      ? `<li><span aria-current="page">${n}</span></li>`
      : `<li><a href="${href(n)}">${n}</a></li>`,
  ]);
  return `<nav class="pager" aria-label="Pages"><ul role="list">
${page > 1 ? `<li><a rel="prev" href="${href(page - 1)}">Previous</a></li>\n` : ""}${items.join("\n")}
${page < last ? `<li><a rel="next" href="${href(page + 1)}">Next</a></li>\n` : ""}</ul></nav>`;
}

// Entities for spaces and zero-width marks, which the sanitizer leaves as written.
const BLANK_ENTITY =
  /&(?:nbsp|ensp|emsp|thinsp|zwnj|zwj|#160|#x0*a0|#820[1-9]|#x200[0-9a-d]|#8203|#65279|#xfeff);?/giu;

/**
 * Whether a summary has anything to read: an image, or text that isn't only
 * spaces, zero-width marks or entities for them. Linear: `[^<>]` can't backtrack.
 */
const hasContent = (html: string) =>
  /<img\b/.test(html) ||
  /[^\s\p{Cf}]/u.test(html.replace(/<[^<>]*>/g, "").replace(BLANK_ENTITY, ""));

// A tag that folds to nothing has no listing, so it is shown without a link.
const tagLinks = (tags: ListedWork["tags"]) =>
  tags
    .map((t) =>
      t.name_norm === ""
        ? escapeHtml(t.name)
        : `<a href="${tagHref(t.type, t.name_norm)}">${escapeHtml(t.name)}</a>`,
    )
    .join(", ");

/** How many relationships, and how many characters, a card names before "+n more". */
const SHOWN_PER_KIND = 3;

const someOf = (tags: ListedWork["tags"]) => {
  const rest = tags.length - SHOWN_PER_KIND;
  return tagLinks(tags.slice(0, SHOWN_PER_KIND)) + (rest > 0 ? `, +${rest} more` : "");
};

/** Relationships, then characters, then how many freeform tags there are besides. */
const cardTags = (
  relationships: ListedWork["tags"],
  characters: ListedWork["tags"],
  others: number,
) =>
  [
    someOf(relationships),
    someOf(characters),
    others ? `${others} other ${others === 1 ? "tag" : "tags"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * The summary as the sanitizer left it, whole: the stylesheet clamps it to three
 * lines. The server can't tell how many lines it takes, so "more" always follows.
 */
const summary = (html: string | null, href: string, title: string) =>
  html && hasContent(html)
    ? `<div class="card-summary">${html}</div>\n<p class="card-more"><a href="${href}" aria-label="more of ${escapeHtml(title)}">more</a></p>`
    : "";

/** Words, chapters as posted/total ("?" when the total is unknown), completion, last updated. */
const stats = (work: ListedWork["work"]) =>
  [
    work.words === null ? "" : `${WORDS.format(work.words)} words`,
    `${work.chapters_count}/${work.chapters_total ?? "?"} chapters`,
    work.complete ? "Complete" : "In progress",
    lastUpdated(work),
  ]
    .filter(Boolean)
    .join(" · ");

/** The updated date, or the published one for a work never updated since. */
const lastUpdated = ({ updated_at, published_at }: ListedWork["work"]) => {
  const at = updated_at ?? published_at;
  return at === null ? "" : `Updated ${at.toISOString().slice(0, 10)}`;
};

/** A card line, or nothing when it would be empty. */
const line = (className: string, html: string) =>
  html ? `<p class="${className}">${html}</p>` : "";

/** The six lines, in order: title and author, rating and warnings, fandoms, summary, tags, stats. */
export function workCard({ work, authors, tags }: ListedWork): string {
  const href = `/works/${work.ao3_work_id}`;
  const ofType = (type: TagType) => tags.filter((t) => t.type === type);
  // Spelled out in bold, never a colour or a symbol, and never clamped.
  const warnings = ofType("warning").map((t) => t.name);
  const rating = [work.rating || NOT_RATED, warnings.join(", ")].filter(Boolean);
  // No byline is shown as an anonymous one is.
  const byline = authors.map((a) => a.pseud).join(", ") || "Anonymous";
  // The article keeps a summary's stray <li> from closing the card's own.
  return `<li><article class="work-card">
<h2 class="card-title"><a href="${href}">${escapeHtml(work.title)}</a></h2>
<p class="card-byline">by ${escapeHtml(byline)}</p>
<p class="card-rating"><strong>${escapeHtml(rating.join(" · "))}</strong></p>
${line("card-fandoms", tagLinks(ofType("fandom")))}
${summary(work.summary_html, href, work.title)}
${line("card-tags", cardTags(ofType("relationship"), ofType("character"), ofType("freeform").length))}
<p class="card-stats">${stats(work)}</p>
</article></li>`;
}
