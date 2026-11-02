// The search page, `/search?q=`: a GET form prefilled with the query and the fandom and
// rating filters, then one page of matching live works as work cards, with a pager
// (FRONTEND-DISCOVERY, Page inventory, Search results). No sign-in. The query and the
// filters are a reader's private input: they are escaped on the page and never logged,
// stored or sent anywhere. No Cache-Control of its own, so the default `private,
// no-store` applies.

import { createDb, searchLiveWorks, tagNameKeys } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { PAGE_SIZE, pager, pageOf, RATINGS, select, workList, type Pair } from "./listing";
import { DRAFT, escapeHtml, layout } from "./pages";

/** The query is in the URL: a cross-site link on a result must not carry it in the Referer. */
const PRIVATE = { "Referrer-Policy": "strict-origin" };

/** The most of a fandom name that is read. */
const MAX_FANDOM = 200;

/** What the URL asks the results to be narrowed by, less anything the form can't send. */
interface Filters {
  /** As typed. Absent for any fandom, or one that folds to no name at all. */
  fandom?: string;
  /** Absent for any rating. */
  rating?: string;
}

function filtersOf(rawFandom: string | undefined, rawRating: string | undefined): Filters {
  const filters: Filters = {};
  // Cut, as the query is: no fandom name is longer, and it is echoed into every link.
  const fandom = rawFandom?.slice(0, MAX_FANDOM);
  if (fandom !== undefined && tagNameKeys("fandom", fandom).length > 0) filters.fandom = fandom;
  if (rawRating !== undefined && RATINGS.includes(rawRating)) filters.rating = rawRating;
  return filters;
}

/** The search box and the filters, as one GET form with the choices in it. The form has no page, so applying a filter returns to the first. */
const searchForm = (
  q: string,
  { fandom, rating }: Filters,
) => `<form role="search" method="get" action="/search">
<label for="q">Search the archive</label>
<input type="search" id="q" name="q" value="${escapeHtml(q)}">
<p><label for="search-fandom">Fandom</label> <input id="search-fandom" name="fandom" type="text" value="${escapeHtml(fandom ?? "")}"></p>
${select("search-rating", "rating", "Rating", [["", "Any"], ...RATINGS.map((r): Pair => [r, r])], rating ?? "")}
<button type="submit">Search</button>
</form>`;

/** The search's URL for this query, filters and page, in a fixed order, escaped for an attribute. */
function searchHref(q: string, { fandom, rating }: Filters, page: number): string {
  const params: Pair[] = [["q", q]];
  if (fandom !== undefined) params.push(["fandom", fandom]);
  if (rating !== undefined) params.push(["rating", rating]);
  if (page !== 1) params.push(["page", String(page)]);
  return escapeHtml(`/search?${new URLSearchParams(params).toString()}`);
}

export async function showSearch(c: Context<{ Bindings: Bindings }>) {
  const q = c.req.query("q") ?? "";
  const filters = filtersOf(c.req.query("fandom"), c.req.query("rating"));
  // A missing or blank query shows the form and no results, whatever the filters.
  if (q.trim() === "") return c.html(layout("Search", searchForm(q, filters)), 200, PRIVATE);
  const page = pageOf(c.req.query("page"));
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const { works, total } = await searchLiveWorks(db, q, {
      pageSize: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      ...filters,
    });
    const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > last) {
      c.header("Referrer-Policy", PRIVATE["Referrer-Policy"]);
      return c.notFound();
    }
    // Draft copy, for the operator to proof.
    const list =
      works.length === 0 ? `<p>No works match your search.</p>\n${DRAFT}` : workList(works);
    const href = (n: number) => searchHref(q, filters, n);
    return c.html(
      layout("Search", `${searchForm(q, filters)}\n${list}\n${pager(href, page, last)}`),
      200,
      PRIVATE,
    );
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
