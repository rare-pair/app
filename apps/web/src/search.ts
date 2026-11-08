// The search page, `/search?q=`: one GET form, the search box with the tag listing's sort and
// filters, then one page of live works as work cards, with a pager (FRONTEND-DISCOVERY, Page
// inventory, Search results). With no query it lists every live work, as a listing does: no
// budget spent, and briefly cached. With one, it is rate-limited, and the query and the filters
// are a reader's private input: escaped on the page, never logged, stored or sent anywhere, and
// the page has no Cache-Control of its own, so the default `private, no-store` applies.
import { createDb, listLiveWorks, searchLiveWorks, type ListedWork } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import {
  CACHED,
  filterFields,
  filterParams,
  filtersOf,
  hrefWith,
  PAGE_SIZE,
  pager,
  pageOf,
  select,
  SORTS,
  workList,
  type Filters,
  type Pair,
} from "./listing";
import { siteCard } from "./cards";
import { escapeHtml, layout } from "./pages";
import { ipKey, isLimited, SEARCH_WINDOW_SECONDS, tooManyRequests, userKey } from "./rate-limit";
import type { SessionVariables } from "./session";

/** The query is in the URL: a cross-site link on a result must not carry it in the Referer. */
const REFERRER_POLICY = "strict-origin";

/** The most of a tag name, and of a query, that is read. The db cuts a query at the same length. */
const MAX_TAG = 200;
const MAX_QUERY = 200;

/** Cut by code point, so an astral character isn't split. What is cut is echoed into every link, so it is cut here too. */
const cut = (text: string, max: number) =>
  Array.from(text.slice(0, max * 2))
    .slice(0, max)
    .join("");

/** Best match first: the default, and the order with no query ranks by updated date. */
const SEARCH_SORTS: Pair[] = [["relevance", "Best match"], ...Object.entries(SORTS)];
type SearchSort = "relevance" | keyof typeof SORTS;
const isSearchSort = (raw: string | undefined): raw is SearchSort =>
  SEARCH_SORTS.some(([value]) => value === raw);

/** What the URL asks for, less anything the form can't send. */
export interface SearchQuery extends Filters {
  /** As typed, cut; blank lists every live work. */
  q: string;
  sort: SearchSort;
}

function searchQueryOf(raw: Record<string, string>): SearchQuery {
  // Postgres refuses a NUL, so the db reads one as a space; the page shows what was searched.
  const q = cut((raw.q ?? "").replaceAll("\0", " "), MAX_QUERY);
  // An older link narrows by `fandom=`: it is the tag field set to fandom.
  const merged: Record<string, string> =
    raw.tag === undefined && raw.fandom !== undefined
      ? { ...raw, tag: raw.fandom, tag_type: "fandom" }
      : { ...raw };
  if (merged.tag !== undefined) merged.tag = cut(merged.tag, MAX_TAG);
  return { q, sort: isSearchSort(raw.sort) ? raw.sort : "relevance", ...filtersOf(merged) };
}

/** The search's URL for this query and page, in a fixed order, escaped for an attribute. */
function searchHref({ q, sort, ...filters }: SearchQuery, page: number): string {
  const params: Pair[] = [];
  if (q.trim() !== "") params.push(["q", q]);
  if (sort !== "relevance") params.push(["sort", sort]);
  params.push(...filterParams(filters));
  if (page !== 1) params.push(["page", String(page)]);
  return hrefWith("/search", params);
}

/** The search box, the sort and the filters, as one GET form with the choices in it. The form has no page, so applying a filter returns to the first. */
const searchForm = (query: SearchQuery) => `<form role="search" method="get" action="/search">
<label for="q" class="visually-hidden">Search the archive</label>
<input type="search" id="q" name="q" value="${escapeHtml(query.q)}">
${select("listing-sort", "sort", "Sort by", SEARCH_SORTS, query.sort)}
${filterFields(query, MAX_TAG)}
<button type="submit">Search</button>
</form>`;

/**
 * The page from what it lists, or null when the page is past the last. Needs no database, so
 * its empty states can be tested alone.
 */
export function allWorksHtml({
  works,
  total,
  page,
  query,
}: {
  works: ListedWork[];
  total: number;
  page: number;
  query: SearchQuery;
}): string | null {
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > last) return null;
  const narrowed = query.q.trim() !== "" || filterParams(query).length > 0;
  // Draft copy, for the operator to proof.
  const list =
    works.length > 0
      ? workList(works)
      : narrowed
        ? "<p>No works match your search.</p>"
        : "<p>There are no works here yet.</p>";
  return layout(
    "Search",
    `${searchForm(query)}\n${list}\n${pager((n) => searchHref(query, n), page, last)}`,
    siteCard(),
  );
}

export async function showSearch(c: Context<{ Bindings: Bindings; Variables: SessionVariables }>) {
  // On every response, an error and a 404 too: the URL holds the reader's query.
  c.header("Referrer-Policy", REFERRER_POLICY);
  const query = searchQueryOf(c.req.query());
  const blank = query.q.trim() === "";
  // A blank query lists every work, as a listing does, and spends none of the budget. A query is
  // counted before the search opens its own database connection, so a refused search runs no
  // query (the session lookup, for a request with a cookie, runs earlier, in the middleware).
  // The user first, so one user over their limit can't spend the budget of an address others
  // share; a search under it still spends the address's. A signed-out search is keyed on its IP only.
  if (!blank) {
    const user = c.var.session?.user;
    const clientIp = c.req.header("cf-connecting-ip") ?? null;
    if (
      (user !== undefined &&
        (await isLimited(c.env.SEARCH_USER_LIMIT, await userKey("search", user.id)))) ||
      (await isLimited(c.env.SEARCH_IP_LIMIT, await ipKey("search", clientIp)))
    ) {
      // A bare Response doesn't carry what was set on the context.
      const limited = tooManyRequests(SEARCH_WINDOW_SECONDS);
      limited.headers.set("Referrer-Policy", REFERRER_POLICY);
      return limited;
    }
  }
  const page = pageOf(c.req.query("page"));
  const { q, sort, rating, tag } = query;
  const complete = query.complete === undefined ? undefined : query.complete === "yes";
  const db = createDb({ connectionString: c.env.HYPERDRIVE_CACHED.connectionString, max: 1 });
  try {
    const { works, total } = blank
      ? // Nothing to match: best match is the listing's order.
        await listLiveWorks(db, {
          sort: sort === "relevance" ? "updated" : sort,
          rating,
          tag,
          complete,
          page,
          pageSize: PAGE_SIZE,
        })
      : await searchLiveWorks(db, q, {
          sort,
          rating,
          tag,
          complete,
          pageSize: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });
    const html = allWorksHtml({ works, total, page, query });
    if (html === null) return c.notFound();
    return blank ? c.html(html, 200, CACHED) : c.html(html);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
