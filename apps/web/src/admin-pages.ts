// The moderation area's markup: the /admin home page and the queue tables. Plain
// HTML with no script, as every page here (FRONTEND-DISCOVERY, Moderation queues).

import { escapeHtml, layout } from "./pages";

/** The most rows a queue shows, oldest first. Docs are silent on paging. */
export const QUEUE_LIMIT = 200;

/** One table row's cells, as text: each is escaped here. */
export type Row = string[];

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
  const body = shown
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("\n");
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
