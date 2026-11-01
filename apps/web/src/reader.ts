// The chapter reader: /works/:id/chapters/:n renders the current version's
// sanitized fragment from R2 inline in the page (ARCHITECTURE, Reading).

import { createDb, getLiveWork, getWorkAvailability } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { escapeHtml, layout } from "./pages";
import { reviewNotice } from "./review-notice";
import { positionScriptTag } from "./position";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { barSettings, settingsScriptTag } from "./settings";
import { withheldResponse } from "./withheld";

export type ReaderContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

const MAX_INT4 = 2_147_483_647;

/**
 * A work ID or chapter number from a URL: plain ASCII digits with no leading zero,
 * within Postgres's int4. Null for anything else, so `007` is not chapter 7.
 */
export const positiveInt = (text: string | undefined) => {
  if (text === undefined || !/^[1-9]\d{0,9}$/.test(text)) return null;
  const value = Number(text);
  return value <= MAX_INT4 ? value : null;
};

export async function showChapter(c: ReaderContext) {
  const id = positiveInt(c.req.param("id"));
  const n = positiveInt(c.req.param("n"));
  if (id === null) return c.notFound();

  // Two sequential queries at most, so one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  let live;
  let withheld;
  try {
    live = await getLiveWork(db, id);
    if (!live) withheld = await getWorkAvailability(db, id);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
  // A hidden or removed work answers 451 or 410 for any chapter number, in range or
  // not, so a 404 on one and a 451 on another can't give away its chapter count.
  if (withheld) return withheldResponse(c, withheld);
  if (!live || n === null) return c.notFound();
  const at = live.chapters.findIndex((ch) => ch.n === n);
  const chapter = live.chapters[at];
  if (!chapter) return c.notFound();

  // Chapter HTML comes only from a fragment the sanitizer wrote, under works/ and this
  // version's own prefix: never an upload, an original or an image, whatever the row says.
  const key = chapter.r2_key;
  if (!key.startsWith("works/") || !isFragmentKey(key, id, live.version.r2_prefix)) {
    return unavailable(c);
  }
  // The fragment is trusted markup only because the sanitizer wrote it; it goes in unescaped.
  let fragment: string;
  try {
    const object = await c.env.BUCKET.get(key);
    if (!object) return unavailable(c);
    fragment = await object.text();
  } catch {
    return unavailable(c);
  }

  // Previous and next are the neighbours in the version's chapter list.
  const options = chapterOptions(n, live.chapters);
  const prev = live.chapters[at - 1]?.n ?? null;
  const next = live.chapters[at + 1]?.n ?? null;
  const nav = (end: "top" | "bottom") => chapterNav(id, prev, next, options, end);
  const workTitle = live.work.title.trim() || "Untitled work";
  const bar = readerBar(workTitle, chapterUrl(id, n));
  // The processor takes the chapter's heading out of the fragment and keeps it as its
  // title, so the page shows it, as chrome, above the text.
  return c.html(
    layout(
      `${workTitle}, chapter ${n}`,
      `${reviewNotice(live.version)}${nav("top")}
<h2 class="chapter-title">${escapeHtml(chapterTitle(chapter))}</h2>
<article class="chapter">${fragment}</article>
${nav("bottom")}`,
      `${settingsScriptTag(c.get("nonce"))}${positionScriptTag(c.get("nonce"), c.var.session)}`,
      bar,
    ),
  );
}

/**
 * The slim top bar every reading page shares: the work title, which is the page's one
 * h1, and the reader settings, coming back to `returnTo`. It scrolls away with the
 * page. The page's head needs `settingsScriptTag` for the live controls.
 */
export const readerBar = (workTitle: string, returnTo: string) =>
  `<div class="reader-bar"><h1>${escapeHtml(workTitle)}</h1>${barSettings(returnTo)}</div>`;

/**
 * The chapter select's target: `/works/:id/chapters?n=5` goes to chapter 5. The
 * Location is built from the two validated numbers, never from the query text; a
 * chapter past the last is the chapter page's own 404.
 */
export function jumpToChapter(c: ReaderContext) {
  const id = positiveInt(c.req.param("id"));
  const n = positiveInt(c.req.query("n"));
  if (id === null || n === null) return c.notFound();
  return c.redirect(chapterUrl(id, n), 303);
}

/** A work's chapters, and one chapter's URL, from numbers only. */
const chaptersUrl = (id: number) => `/works/${id}/chapters`;
const chapterUrl = (id: number, n: number) => `${chaptersUrl(id)}/${n}`;

/** A chapter's title, or "Chapter n" when it has none, as the processor names one. */
export const chapterTitle = (ch: { n: number; title: string }) =>
  ch.title.trim() || `Chapter ${ch.n}`;

/** The select's options, every chapter with the current one selected. */
const chapterOptions = (n: number, chapters: { n: number; title: string }[]) =>
  chapters
    .map(
      (ch) =>
        `<option value="${ch.n}"${ch.n === n ? " selected" : ""}>${ch.n}. ${escapeHtml(chapterTitle(ch))}</option>`,
    )
    .join("");

/**
 * Previous, a select of every chapter, and next. There is no previous link on the
 * first chapter and no next link on the last. The select's form is a plain GET, so
 * it works without JavaScript.
 */
function chapterNav(
  id: number,
  prev: number | null,
  next: number | null,
  options: string,
  end: "top" | "bottom",
) {
  const label = end === "top" ? "Chapters" : "Chapters, end of page";
  return `<nav class="chapter-nav" aria-label="${label}">
${prev === null ? "" : `<a rel="prev" href="${chapterUrl(id, prev)}">Previous chapter</a>`}
<form method="get" action="${chaptersUrl(id)}">
<label for="chapter-${end}">Chapter</label>
<select id="chapter-${end}" name="n">${options}</select>
<button type="submit">Go</button>
</form>
${next === null ? "" : `<a rel="next" href="${chapterUrl(id, next)}">Next chapter</a>`}
</nav>`;
}

/**
 * Whether a chapter's key is a fragment of this work's version: the version's prefix is
 * `works/<ao3_work_id>/<upload_id>/` for this work (ARCHITECTURE, Why these pieces),
 * never its `img/` folder, and the key is a file directly under it.
 */
export function isFragmentKey(key: string, id: number, prefix: string) {
  const upload = prefix.match(new RegExp(`^works/${id}/([^/]+)/$`))?.[1];
  if (upload === undefined || upload === "img" || upload === "." || upload === "..") return false;
  const file = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  return file !== "" && !file.includes("/");
}

/** A chapter whose fragment can't be read: empty, uncached, and no detail. */
export const unavailable = (c: ReaderContext) => c.body(null, 503, { "Cache-Control": "no-store" });
