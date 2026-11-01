// The search page, `/search?q=`: a GET form prefilled with the query, then one page of
// matching live works as work cards (FRONTEND-DISCOVERY, Page inventory, Search results).
// No sign-in. The query is a reader's private input: it is escaped on the page and
// never logged, stored or sent anywhere. No Cache-Control of its own, so the default
// `private, no-store` applies.

import { createDb, searchLiveWorks } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { workList } from "./listing";
import { DRAFT, escapeHtml, layout } from "./pages";

/** Works per page. */
const PAGE_SIZE = 20;

/** The search box with the query in it. The shared SEARCH_FORM has no value to prefill. */
const searchForm = (q: string) => `<form role="search" method="get" action="/search">
<label for="q">Search the archive</label>
<input type="search" id="q" name="q" value="${escapeHtml(q)}">
<button type="submit">Search</button>
</form>`;

export async function showSearch(c: Context<{ Bindings: Bindings }>) {
  const q = c.req.query("q") ?? "";
  // A missing or blank query shows the empty form and no results.
  if (q.trim() === "") return c.html(layout("Search", searchForm(q)));
  const page = 1;
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const { works } = await searchLiveWorks(db, q, {
      pageSize: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    // Draft copy, for the operator to proof.
    const list =
      works.length === 0 ? `<p>No works match your search.</p>\n${DRAFT}` : workList(works);
    return c.html(layout("Search", `${searchForm(q)}\n${list}`));
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
