import { escapeHtml } from "./pages";
import { fnv1a } from "./styles";
import { LABELS, REFRESH_SECONDS, REJECTED } from "./upload-badge";

/**
 * The My uploads script, served from MY_UPLOADS_SCRIPT_PATH and loaded with the page's
 * nonce while some upload is in progress. Every REFRESH_SECONDS it asks `GET /uploads/:id`
 * about each row marked `data-polling` and rewrites that row's badge in place; a row that
 * went live gets a link to its work. A row leaves the set when it is no longer in
 * progress or answers 404, and the script stops when the set is empty. A 401 (the session
 * ended) reloads the page, which lands on sign-in. A network error or a 5xx waits for the
 * next round. Nothing polls while the tab is hidden. Page text is only ever set with
 * `textContent` and `setAttribute`.
 *
 * The labels are the server's (upload-badge.ts), interpolated; the in-progress rule
 * repeats `inProgress` for a confirmed upload, since only a confirmed row is polled.
 */
export const MY_UPLOADS_SCRIPT = `"use strict";
(() => {
  const LABELS = ${JSON.stringify(LABELS)};
  const REJECTED = ${JSON.stringify(REJECTED)};
  const INTERVAL = ${REFRESH_SECONDS * 1000};
  const rows = new Set(document.querySelectorAll("li[data-upload-id][data-polling]"));
  if (rows.size === 0) return;
  const label = (status) => (status === "pending" ? LABELS.processing : Object.hasOwn(LABELS, status) ? LABELS[status] : REJECTED);
  const waiting = (status) => status === "pending" || status === "processing";
  let timer = 0;
  let busy = false;
  const poll = async (li) => {
    let res;
    try {
      res = await fetch("/uploads/" + encodeURIComponent(li.getAttribute("data-upload-id")), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(INTERVAL * 2),
      });
    } catch (e) {
      return;
    }
    if (res.status === 401) {
      rows.clear();
      location.reload();
      return;
    }
    if (res.status === 404) {
      li.removeAttribute("data-polling");
      rows.delete(li);
      return;
    }
    if (!res.ok) return;
    let body;
    try {
      body = await res.json();
    } catch (e) {
      return;
    }
    if (!body || typeof body.status !== "string") return;
    show(li, body);
  };
  const show = (li, body) => {
    const badge = li.querySelector(".badge");
    if (badge) badge.textContent = label(body.status);
    li.setAttribute("data-status", body.status);
    const url = body.work && body.work.url;
    const name = li.querySelector(".upload-name");
    if (name && typeof url === "string" && /^\\/works\\/[1-9][0-9]{0,9}$/.test(url) && !name.querySelector("a")) {
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.textContent = "View the work";
      name.textContent = "";
      name.append(link);
    }
    if (!waiting(body.status)) {
      li.removeAttribute("data-polling");
      rows.delete(li);
    }
  };
  const schedule = () => {
    if (rows.size > 0) timer = setTimeout(tick, INTERVAL);
  };
  const tick = async () => {
    timer = 0;
    if (document.hidden || busy) return;
    busy = true;
    try {
      await Promise.allSettled(Array.from(rows, poll));
    } finally {
      busy = false;
    }
    schedule();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || busy || rows.size === 0) return;
    clearTimeout(timer);
    return tick();
  });
  schedule();
})();
`;

/** The script's URL carries a hash of it, so the response never changes under it. */
export const MY_UPLOADS_SCRIPT_PATH = `/assets/my-uploads.${fnv1a(MY_UPLOADS_SCRIPT)}.js`;

/** The script's tag for the My uploads page, deferred so the list is parsed first. */
export const myUploadsScriptTag = (nonce: string) =>
  `<script src="${MY_UPLOADS_SCRIPT_PATH}" nonce="${escapeHtml(nonce)}" defer></script>`;
