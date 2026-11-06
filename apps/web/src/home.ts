// The home page, `/`: the search box first, then the latest updates, the popular
// fandoms and the recently added works (FRONTEND-DISCOVERY, Decisions so far, Home page).
// Live works only. No Cache-Control of its own, so the default `private, no-store` applies.

import { createDb, listPopularFandoms, listRecentLiveWorks } from "@archive/db";
import type { Bindings } from "./env";
import { workList } from "./listing";
import { siteCard } from "./cards";
import { DRAFT, escapeHtml, layout, SEARCH_FORM } from "./pages";
import { tagHref } from "./tag-links";
import { updatesSection } from "./updates";
import { type Update, UPDATES } from "./updates-data";

type Fandoms = Awaited<ReturnType<typeof listPopularFandoms>>;
type Works = Awaited<ReturnType<typeof listRecentLiveWorks>>;

/** The page from what it lists. Needs no database, so the updates' place can be tested alone. */
export function homeHtml({
  fandoms,
  works,
  updates,
}: {
  fandoms: Fandoms;
  works: Works;
  updates: readonly Update[];
}): string {
  // No fandom tag among the live works: no empty list under a heading.
  const popular =
    fandoms.length === 0
      ? ""
      : `<h2>Popular fandoms</h2>
<ul class="fandom-list" role="list">
${fandoms.map((f) => `<li><a href="${tagHref("fandom", f.name_norm)}">${escapeHtml(f.name)}</a></li>`).join("\n")}
</ul>`;
  // Nothing live: one plain line. Draft copy, for the operator to proof.
  const lists =
    works.length === 0
      ? `<p>There are no works here yet.</p>\n${DRAFT}`
      : `${popular}
<h2>Recently added</h2>
${workList(works)}`;
  return layout(
    "Home",
    [SEARCH_FORM, updatesSection(updates), lists].filter((part) => part !== "").join("\n"),
    siteCard(),
  );
}

export async function homePage(
  env: Pick<Bindings, "HYPERDRIVE_CACHED">,
  ctx: Pick<ExecutionContext, "waitUntil">,
  updates: readonly Update[] = UPDATES,
): Promise<string> {
  // Two queries, one after another, on one connection.
  const db = createDb({ connectionString: env.HYPERDRIVE_CACHED.connectionString, max: 1 });
  try {
    const fandoms = await listPopularFandoms(db);
    const works = await listRecentLiveWorks(db);
    return homeHtml({ fandoms, works, updates });
  } finally {
    ctx.waitUntil(db.destroy());
  }
}
