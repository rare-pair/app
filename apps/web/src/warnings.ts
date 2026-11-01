// The rating and warnings screen: /works/:id/warnings, shown before a work's text to a
// reader who hasn't continued past it this session (ARCHITECTURE, Reading). Having
// continued is a session cookie of work IDs. Every reading page makes one call to
// `warningsRedirect` before it reads a fragment.

import { createDb, getLiveWork, getWorkAvailability } from "@archive/db";
import type { LiveWork } from "@archive/db";
import { getCookie } from "hono/cookie";
import { readForm } from "./login";
import { escapeHtml, layout } from "./pages";
import { positiveInt, type ReaderContext } from "./reader";
import { withheldResponse } from "./withheld";

/**
 * The cookie's name. `__Host-`: Secure, Path=/ and no Domain, so it never reaches the
 * content origin. HttpOnly, since no script reads it.
 */
export const WARNED_COOKIE = "__Host-warned";
// No Max-Age or Expires, so it ends with the browser session.
const WARNED_ATTRIBUTES = "; Path=/; SameSite=Lax; Secure; HttpOnly";
// The most work IDs kept; the oldest are dropped past it.
const MAX_WARNED = 50;

const MILD_RATINGS = ["general audiences", "teen and up audiences"];

/**
 * Whether a work gets the screen: rated Mature or Explicit, not rated, or carrying any
 * archive warning other than "No Archive Warnings Apply".
 */
export function needsWarnings({
  work,
  tags,
}: {
  work: { rating: string | null };
  tags: { type: string; name_norm: string }[];
}) {
  // Only the two mild ratings skip the screen; anything else, an unknown or oddly
  // spelled rating included, shows it.
  const rating = work.rating?.trim().toLowerCase() ?? "";
  if (!MILD_RATINGS.includes(rating)) return true;
  return tags.some(
    (tag) => tag.type === "warning" && tag.name_norm !== "no archive warnings apply",
  );
}

/** The work IDs a cookie value holds, oldest first: digits only, anything else dropped. */
export function parseWarned(value: string | undefined): number[] {
  if (!value) return [];
  const ids: number[] = [];
  for (const part of value.split(".")) {
    const id = positiveInt(part);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(-MAX_WARNED);
}

/** The whole `Set-Cookie` value that stores `ids`. */
export const warnedCookie = (ids: number[]) =>
  `${WARNED_COOKIE}=${ids.slice(-MAX_WARNED).join(".")}${WARNED_ATTRIBUTES}`;

const warnedIds = (c: ReaderContext) => parseWarned(getCookie(c, WARNED_COOKIE));

/**
 * Where Continue goes: this work's `/chapters/<n>` or `/full`, exactly, else chapter 1.
 * Never the text of the request.
 */
export function safeWarningsNext(id: number, next: string | undefined) {
  const first = `/works/${id}/chapters/1`;
  if (next === `/works/${id}/full`) return next;
  const n = next?.match(/^\/works\/\d+\/chapters\/(.+)$/)?.[1];
  const number = positiveInt(n);
  return number !== null && next === `/works/${id}/chapters/${number}` ? next : first;
}

/**
 * The redirect to the screen for a reader who hasn't seen it, or null to read on.
 * `next` is the page asked for, built by the caller from numbers.
 */
export function warningsRedirect(c: ReaderContext, live: LiveWork, next: string) {
  const id = live.work.ao3_work_id;
  if (!needsWarnings(live) || warnedIds(c).includes(id)) return null;
  c.header("Cache-Control", "private, no-store");
  return c.redirect(`/works/${id}/warnings?next=${encodeURIComponent(next)}`, 302);
}

/** `GET /works/:id/warnings`: the rating and warnings, and Continue. */
export async function showWarnings(c: ReaderContext) {
  const id = positiveInt(c.req.param("id"));
  if (id === null) return c.notFound();
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  let live;
  let withheld;
  try {
    live = await getLiveWork(db, id);
    if (!live) withheld = await getWorkAvailability(db, id);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
  if (!live) return withheld ? withheldResponse(c, withheld) : c.notFound();
  const next = safeWarningsNext(id, c.req.query("next"));
  // Nothing to warn about: on to the page asked for.
  if (!needsWarnings(live)) {
    c.header("Cache-Control", "private, no-store");
    return c.redirect(next, 302);
  }

  const rating = escapeHtml(live.work.rating?.trim() || "Not Rated");
  const warnings = live.tags.filter((tag) => tag.type === "warning");
  const title = live.work.title.trim() || "Untitled work";
  return c.html(
    layout(
      "Rating and warnings",
      `<p class="work-title">${escapeHtml(title)}</p>
<p class="rating">Rating: ${rating}</p>
${warnings.length === 0 ? "" : `<ul class="warnings">${warnings.map((tag) => `<li>${escapeHtml(tag.name)}</li>`).join("")}</ul>\n`}<form method="post" action="/works/${id}/warnings">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Continue</button>
</form>
<p><a href="/works/${id}">Back to the work</a></p>`,
    ),
  );
}

/** `POST /works/:id/warnings`: remember the work for the session and go on, 303. */
export async function continueWarnings(c: ReaderContext) {
  const id = positiveInt(c.req.param("id"));
  if (id === null) return c.notFound();
  const form = await readForm(c.req.raw);
  if (form === null) return c.body(null, 413);
  const ids = warnedIds(c).filter((seen) => seen !== id);
  c.header("Set-Cookie", warnedCookie([...ids, id]), { append: true });
  c.header("Cache-Control", "private, no-store");
  return c.redirect(safeWarningsNext(id, form.get("next") ?? undefined), 303);
}
