// The moderation area's markup: the /admin home page and the queue tables. Plain
// HTML with no script, as every page here (FRONTEND-DISCOVERY, Moderation queues).

import { escapeHtml, layout } from "./pages";

/** The most rows a queue shows, oldest first. Docs are silent on paging. */
export const QUEUE_LIMIT = 200;

/**
 * One table row's cells, as text: each is escaped here. `href`, a path this app builds
 * from ids, makes the first cell a link to the row's detail page.
 */
export type Row = { cells: string[]; href?: string };

export const REPORT_COLUMNS = ["Created", "Work", "Kind", "Details"];
export const TAKEDOWN_COLUMNS = [
  "Created",
  "Work",
  "Requester",
  "Basis",
  "Material",
  "Signature",
  "Statements",
  "Incomplete",
];
export const REQUEST_COLUMNS = ["Created", "Kind", "Work or pseud", "Contact email", "Statement"];
export const WORK_COLUMNS = ["Created", "Work", "Reason"];

const QUEUES = [
  { href: "/admin/reports", name: "Reports" },
  { href: "/admin/takedowns", name: "Takedowns" },
  { href: "/admin/requests", name: "Requests" },
  { href: "/admin/works", name: "Works to check" },
];

const nav = `<nav aria-label="Moderation queues"><ul>${QUEUES.map((q) => `<li><a href="${q.href}">${q.name}</a></li>`).join("")}</ul></nav>`;

/** `/admin`: the four queues. */
export const adminHomePage = () => layout("Moderation", nav);

/** A row's cells, the first one a link when the row has an `href`. */
const rowHtml = (row: Row) =>
  `<tr>${row.cells
    .map((text, i) => {
      const cell = escapeHtml(text);
      return `<td>${i === 0 && row.href !== undefined ? `<a href="${escapeHtml(row.href)}">${cell}</a>` : cell}</td>`;
    })
    .join("")}</tr>`;

/**
 * A queue: its table, oldest first, with headings even when empty. `rows` may hold
 * one more than QUEUE_LIMIT, which says the queue has more than it shows. `empty`
 * is the line an empty queue shows.
 */
export function queuePage(
  title: string,
  columns: string[],
  rows: Row[],
  empty = "Nothing waiting.",
) {
  const shown = rows.slice(0, QUEUE_LIMIT);
  const head = columns.map((name) => `<th scope="col">${escapeHtml(name)}</th>`).join("");
  const body = shown.map(rowHtml).join("\n");
  const note =
    shown.length === 0
      ? `<p>${escapeHtml(empty)}</p>\n`
      : rows.length > QUEUE_LIMIT
        ? `<p>Showing the oldest ${QUEUE_LIMIT}.</p>\n`
        : "";
  return layout(
    title,
    `${nav}
<table>
<caption>${escapeHtml(title)}, oldest first</caption>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
${note}`,
  );
}

/** The names for a work's status on an item page: its status, and the cause while hidden. */
export const workStatusText = (status: string, hiddenCause: string | null) =>
  hiddenCause === null ? status : `${status} (${hiddenCause})`;

/**
 * An item's detail page: its fields as a list, then the actions each as a form.
 * `actions` is trusted markup from this file (`workActions`, `rejectForm`).
 */
export function itemPage(title: string, fields: [string, string][], actions: string) {
  const list = fields
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("\n");
  return layout(title, `${nav}\n<dl>\n${list}\n</dl>\n${actions}`);
}

/**
 * Where an action's page may link back to: an item's own page. `from` is a form
 * field, so anything else is dropped.
 */
export const safeFrom = (from: string | null | undefined) =>
  from !== null &&
  from !== undefined &&
  /^\/admin\/(reports|takedowns|requests)\/[\w%-]+$/.test(from)
    ? from
    : null;

/**
 * The hide, restore and remove forms for a work, by its AO3 work ID, posting to
 * `/admin/works/:id/hide`, `/restore` and `/remove` (which asks to confirm first).
 * MOD4's work page includes the same forms.
 * `from` is the page to link back to afterwards, or null.
 */
export function workActions(ao3WorkId: number, from: string | null) {
  const back = from === null ? "" : `<input type="hidden" name="from" value="${escapeHtml(from)}">`;
  const form = (action: string, label: string) =>
    `<form method="post" action="/admin/works/${ao3WorkId}/${action}">${back}<button type="submit">${label}</button></form>`;
  return `${form("hide", "Hide work")}\n${form("restore", "Restore work")}\n${form("remove", "Remove work")}`;
}

/**
 * The step before a remove, which can't be undone: names the work and posts the
 * remove again with `confirm`, carrying `from` on.
 */
export function removeConfirmPage(title: string, ao3WorkId: number, from: string | null) {
  const back = from === null ? "" : `<input type="hidden" name="from" value="${escapeHtml(from)}">`;
  return layout(
    "Remove work",
    `${nav}
<p>Remove ${escapeHtml(title)} (${ao3WorkId})? Its pages answer 410 and its files are deleted. This can't be undone.</p>
<form method="post" action="/admin/works/${ao3WorkId}/remove">${back}<input type="hidden" name="confirm" value="yes"><button type="submit">Remove work for good</button></form>`,
  );
}

/** A form that rejects a takedown or a request, by the row's own id. */
export const rejectForm = (queue: "takedowns" | "requests", id: string) =>
  `<form method="post" action="${escapeHtml(`/admin/${queue}/${encodeURIComponent(id)}/reject`)}"><button type="submit">Reject</button></form>`;

/**
 * What an action did, said from what its write returned: a re-read could come from
 * Hyperdrive's cache and show the old state. `back` is the page to return to.
 */
export function resultPage(message: string, back: string | null) {
  const link = back === null ? "" : `<p><a href="${escapeHtml(back)}">Back to the item</a></p>`;
  return layout("Done", `${nav}\n<p>${escapeHtml(message)}</p>\n${link}`);
}

/** One version of a work, as its admin page lists it. */
export type VersionRow = {
  id: string;
  added: string;
  uploader: string;
  chapters: number;
  current: boolean;
  /** Held for review: only a moderator's approval makes it current (MOD3). */
  held: boolean;
};

/**
 * A work's admin page: its status and every version, oldest first, each with a "Make
 * current" form unless it is held for review; the current one is marked. The uploader is the
 * account's email: moderators only, on admin pages only. `actions` is `workActions`.
 */
export function workAdminPage(
  title: string,
  ao3WorkId: number,
  status: string,
  versions: VersionRow[],
  actions: string,
) {
  const makeCurrent = (v: VersionRow) =>
    v.held
      ? "Held for review"
      : `${v.current ? "Current " : ""}<form method="post" action="/admin/works/${ao3WorkId}/current"><input type="hidden" name="version" value="${escapeHtml(v.id)}"><button type="submit">Make current</button></form>`;
  const rows = versions
    .map(
      (v) =>
        `<tr><td>${escapeHtml(v.added)}</td><td>${escapeHtml(v.uploader)}</td><td>${v.chapters}</td><td>${makeCurrent(v)}</td></tr>`,
    )
    .join("\n");
  return layout(
    `${title} (${ao3WorkId})`,
    `${nav}
<p>Status: ${escapeHtml(status)}</p>
<table>
<caption>Versions, oldest first</caption>
<thead><tr><th scope="col">Added</th><th scope="col">Uploader</th><th scope="col">Chapters</th><th scope="col">Action</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${actions}`,
  );
}
