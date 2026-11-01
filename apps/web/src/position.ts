// The saved reading position (ARCHITECTURE, Reading): a signed-in reader's chapter and
// scroll percentage, in KV under one key per reader and work. A script on the reading
// pages writes it through POST /works/:id/position; the work page reads it back as a
// "Continue where you left off" link. The key and value are made of numbers only, so
// nothing a reader sends is ever echoed into a page.

import type { Context } from "hono";
import { readForm } from "./login";
import { escapeHtml } from "./pages";
import type { Bindings } from "./env";
import type { SecurityVariables } from "./security";
import type { Session, SessionVariables } from "./session";
import { fnv1a } from "./styles";

export type Position = {
  /** The chapter number, or null when the reader was on the entire-work page. */
  n: number | null;
  /** How far down the page, a whole number from 0 to 100. */
  pct: number;
};

const MAX_INT4 = 2_147_483_647;
// A year: a reader who comes back after longer starts again from the top.
const POSITION_TTL_SECONDS = 365 * 24 * 60 * 60;
// A save is a few small fields; anything bigger is not from the script.
const MAX_BODY = 256;
const NO_STORE = { "Cache-Control": "no-store" };

/** KV's key for one reader's place in one work: the user ID and the AO3 work ID. */
export const positionKey = (userId: string, workId: number) => `pos:${userId}:${workId}`;

export const serializePosition = (position: Position) => JSON.stringify(position);

// The one shape serializePosition writes, and so the only one read back.
const STORED = /^\{"n":(null|[1-9]\d{0,9}),"pct":(0|[1-9]\d?|100)\}$/;

/**
 * The position a stored value holds, or null for anything else: a missing key, or text
 * that is not exactly what serializePosition writes. A value is never trusted for having
 * been stored: it is checked again here, so a bad one means no link.
 */
export function parsePosition(raw: string | null): Position | null {
  const [, chapter, pct] = raw === null ? [] : (STORED.exec(raw) ?? []);
  if (chapter === undefined || pct === undefined) return null;
  const n = chapter === "null" ? null : Number(chapter);
  if (n !== null && n > MAX_INT4) return null;
  return { n, pct: Number(pct) };
}

/**
 * The Continue link's target: the chapter in the path, or the entire-work page when no
 * chapter was saved, and the percentage in a fragment the position script reads once.
 */
export const continueHref = (workId: number, { n, pct }: Position) =>
  `/works/${workId}/${n === null ? "full" : `chapters/${n}`}#pos=${pct}`;

/**
 * The position script, served from POSITION_SCRIPT_PATH and loaded with the page's
 * nonce on the reading pages of a signed-in reader. Once the reader has scrolled and
 * paused for DELAY, it posts the chapter number (from the path; none on the entire-work
 * page) and the scroll percentage. KV takes one write a second to a key, so the pause
 * is well past that. It scrolls only when the page was opened from the Continue link,
 * whose fragment names the place: it does that once, on load, and removes the fragment.
 */
export const POSITION_SCRIPT = `"use strict";
(() => {
  const DELAY = 5000;
  const page = location.pathname.match(/^\\/works\\/([1-9][0-9]{0,9})\\/(?:chapters\\/([1-9][0-9]{0,9})|full)$/);
  if (!page) return;
  const root = document.documentElement;
  const room = () => root.scrollHeight - window.innerHeight;
  const percent = () =>
    room() > 0 ? Math.min(100, Math.max(0, Math.round((window.scrollY / room()) * 100))) : 0;
  const send = () => {
    const body = new URLSearchParams({ pct: String(percent()) });
    if (page[2]) body.set("n", page[2]);
    fetch("/works/" + page[1] + "/position", { method: "POST", body, keepalive: true }).catch(() => {});
  };
  const place = location.hash.match(/^#pos=([0-9]{1,3})$/);
  if (place) {
    history.replaceState(null, "", location.pathname + location.search);
    const restore = () => window.scrollTo(0, (room() * Math.min(100, Number(place[1]))) / 100);
    if (document.readyState === "complete") restore();
    else window.addEventListener("load", restore, { once: true });
  }
  let timer = 0;
  window.addEventListener(
    "scroll",
    () => {
      clearTimeout(timer);
      timer = setTimeout(send, DELAY);
    },
    { passive: true },
  );
})();
`;

/** The script's URL carries a hash of it, so the response never changes under it. */
export const POSITION_SCRIPT_PATH = `/assets/reading-position.${fnv1a(POSITION_SCRIPT)}.js`;

/**
 * The script's tag for a reading page, or nothing for a signed-out reader, who has no
 * position to save. Only the 200 reading page asks for it, after every refusal.
 */
export const positionScriptTag = (
  nonce: string,
  session: Session | null,
  load: "defer" | "async" = "defer",
) =>
  session === null
    ? ""
    : `<script src="${POSITION_SCRIPT_PATH}" nonce="${escapeHtml(nonce)}" ${load}></script>`;

type PositionContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

/** A work ID or chapter number as a URL or form spells it: digits, no leading zero, in int4. */
const wholeNumber = (text: string | undefined | null) => {
  if (text === undefined || text === null || !/^[1-9]\d{0,9}$/.test(text)) return null;
  const value = Number(text);
  return value <= MAX_INT4 ? value : null;
};

/**
 * `POST /works/:id/position`, behind `sameOriginOnly`: stores the signed-in reader's
 * place, a form of `pct` (0 to 100) and `n` (the chapter, left out on the entire-work
 * page). It writes only the caller's own key and checks nothing about the work: a
 * position for a work that is gone is never shown, since the link needs a live chapter.
 * A script calls it, so it answers with a status and no body, never a redirect.
 * Nothing about the reader or the work is logged.
 */
export async function savePosition(c: PositionContext) {
  const user = c.var.session?.user;
  if (user === undefined) return c.body(null, 401, NO_STORE);
  const id = wholeNumber(c.req.param("id"));
  if (id === null) return c.body(null, 404, NO_STORE);

  const form = await readForm(c.req.raw, MAX_BODY);
  const pct = form?.get("pct") ?? "";
  const chapter = form?.get("n") ?? null;
  const n = chapter === null ? null : wholeNumber(chapter);
  if (form === null || !/^(?:0|[1-9]\d?|100)$/.test(pct) || (chapter !== null && n === null)) {
    return c.body(null, 400, NO_STORE);
  }
  try {
    await c.env.POSITIONS.put(
      positionKey(user.id, id),
      serializePosition({ n, pct: Number(pct) }),
      { expirationTtl: POSITION_TTL_SECONDS },
    );
  } catch {
    // KV rate-limits and fails now and then; the script sends the next one a pause later.
    return c.body(null, 503, NO_STORE);
  }
  return c.body(null, 204, NO_STORE);
}

/**
 * The reader's saved place in a work, for the work page, or null for a signed-out
 * reader, no key, a bad value or KV failing: the link is an extra, never a reason for
 * the page to fail.
 */
export async function loadPosition(
  positions: KVNamespace,
  session: Session | null,
  workId: number,
): Promise<Position | null> {
  if (session === null) return null;
  try {
    return parsePosition(await positions.get(positionKey(session.user.id, workId)));
  } catch {
    return null;
  }
}
