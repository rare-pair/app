// The home page's "Updates" section and the static post page (specs/scenarios/mvp/25-updates.md).
// Both take the list as a parameter, so a test can hand them its own.

import { updateCard } from "./cards";
import { escapeHtml, layout } from "./pages";
import { latestUpdates, type Update, UPDATES } from "./updates-data";

const byline = (update: Update) =>
  `<p class="update-meta">${escapeHtml(update.author)} · <time datetime="${escapeHtml(update.created)}">${escapeHtml(update.created)}</time></p>`;

const card = (update: Update) =>
  `<li class="update"><h3><a href="/updates/${escapeHtml(update.slug)}">${escapeHtml(update.title)}</a></h3>
<p>${escapeHtml(update.summary)}</p>
${byline(update)}</li>`;

/** Up to three summary cards, newest first; nothing at all, not even a heading, for none. */
export const updatesSection = (list: readonly Update[]): string => {
  const latest = latestUpdates(list);
  if (latest.length === 0) return "";
  return `<h2>Updates</h2>
<ul class="update-list" role="list">
${latest.map(card).join("\n")}
</ul>`;
};

/** A post's page, or null when no update has the slug. Looked up in an array, so no inherited name matches. */
export const updatePage = (slug: string, list: readonly Update[] = UPDATES): string | null => {
  const update = list.find((candidate) => candidate.slug === slug);
  if (update === undefined) return null;
  return layout(
    update.title,
    `<p>${escapeHtml(update.summary)}</p>
${byline(update)}
<div class="update-body">
${update.body}
</div>`,
    updateCard(update),
  );
};
