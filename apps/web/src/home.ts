// The home page, `/`: the search box first, then the popular fandoms and the
// recently added works (FRONTEND-DISCOVERY, Decisions so far, Home page). Live
// works only. No Cache-Control of its own, so the default `private, no-store` applies.

import { createDb, listPopularFandoms, listRecentLiveWorks } from "@archive/db";
import type { Bindings } from "./env";
import { workList } from "./listing";
import { DRAFT, escapeHtml, layout, SEARCH_FORM } from "./pages";
import { tagHref } from "./tag-links";

export async function homePage(
  env: Pick<Bindings, "HYPERDRIVE">,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<string> {
  // Two queries, one after another, on one connection.
  const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const fandoms = await listPopularFandoms(db);
    const works = await listRecentLiveWorks(db);
    // Nothing live: one plain line. Draft copy, for the operator to proof.
    const lists =
      works.length === 0
        ? `<p>There are no works here yet.</p>\n${DRAFT}`
        : `<h2>Popular fandoms</h2>
<ul class="fandom-list" role="list">
${fandoms.map((f) => `<li><a href="${tagHref("fandom", f.name_norm)}">${escapeHtml(f.name)}</a></li>`).join("\n")}
</ul>
<h2>Recently added</h2>
${workList(works)}`;
    return layout("Home", `${SEARCH_FORM}\n${lists}`);
  } finally {
    ctx.waitUntil(db.destroy());
  }
}
