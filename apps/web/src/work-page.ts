// The work page, `/works/:id`, where :id is the AO3 work ID: a live work's
// metadata in the set order (FRONTEND-DISCOVERY, Typographic system: title,
// author, rating and warnings, fandom, summary, tags, stats), then its chapters.

import { createDb, getLiveWork, getWorkAvailability, type LiveWork } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { escapeHtml, layout } from "./pages";
import type { SecurityVariables } from "./security";
import { TAG_LABELS, tagHref, type LinkedType } from "./tag-links";
import { withheldResponse } from "./withheld";

type WorkContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

type Tag = LiveWork["tags"][number];

/** An AO3 work ID as its URLs spell it: no sign, no leading zero, at most ten digits. */
const AO3_WORK_ID = /^[1-9]\d{0,9}$/;

// The label goes inside the link, so it is part of the link's name when a screen
// reader lists the links or tabs through them.
const tagLink = (tag: Tag & { type: LinkedType }) =>
  `<a href="${tagHref(tag.type, tag.name_norm)}"><span class="visually-hidden">${TAG_LABELS[tag.type]}: </span>${escapeHtml(tag.name)}</a>`;

/** One element of the page, or nothing when it would be empty. */
const block = (tag: "p" | "section", className: string, content: string) =>
  content === "" ? "" : `<${tag} class="${className}">${content}</${tag}>\n`;

const isLinked = (tag: Tag): tag is Tag & { type: LinkedType } =>
  Object.hasOwn(TAG_LABELS, tag.type);

/**
 * The original epub on the content host, `originals/<one segment>` as apps/content
 * serves it. The segment is the upload that made this version, the third part of
 * its prefix (`works/<ao3_work_id>/<upload_id>/`). Provisional: #119 settles the key.
 */
const originalHref = (r2Prefix: string) =>
  `https://content.rarepair.fans/originals/${encodeURIComponent(r2Prefix.split("/")[2] ?? "")}`;

/** The work page's markup. Every stored string is escaped except the summary, sanitized at ingest. */
export function workPage(live: LiveWork): string {
  const { work, authors, tags, chapters, version } = live;
  // The reading pages go by the AO3 work ID too, a number, so safe in an href.
  const base = `/works/${work.ao3_work_id}`;
  const warnings = tags.filter((tag) => tag.type === "warning").map((tag) => escapeHtml(tag.name));
  const rating = escapeHtml(work.rating ?? "Not Rated");
  const ratingLine = warnings.length === 0 ? rating : `${rating} · ${warnings.join(", ")}`;
  const linked = tags.filter(isLinked);
  const fandoms = linked.filter((tag) => tag.type === "fandom");
  const listed = linked.filter((tag) => tag.type !== "fandom");
  // An epub with no byline stores no author.
  const byline =
    authors.length === 0 ? "Anonymous" : authors.map((a) => escapeHtml(a.pseud)).join(", ");
  // The parser wasn't sure of the chapters, and no moderator has checked them yet.
  const needsCheck = version.review_reasons.length > 0 && version.checked_at === null;
  // The words and chapter counts are the current version's, like the chapter list
  // below them. Ingest stores no version without chapters.
  const words = chapters.reduce((sum, ch) => sum + ch.words, 0);
  const stats = [
    `${words.toLocaleString("en")} words`,
    `Chapters ${version.chapter_count}/${version.chapter_total ?? "?"}`,
    work.complete ? "Complete" : "In progress",
    work.updated_at === null ? null : `Updated ${work.updated_at.toISOString().slice(0, 10)}`,
  ].filter((part) => part !== null);
  return layout(
    work.title,
    `<p class="authors">by ${byline}</p>
<p class="rating-warnings">${ratingLine}</p>
${block("p", "fandoms", fandoms.map(tagLink).join(", "))}${block("section", "summary", work.summary_html ?? "")}${block("p", "tags", listed.map(tagLink).join(", "))}<p class="stats">${stats.join(" · ")}</p>
${needsCheck ? `<p class="review-notice">Chapters may be imperfect; a moderator will check.</p>\n` : ""}<ol class="chapters">${chapters.map((ch) => `<li><a href="${base}/chapters/${ch.n}">${escapeHtml(ch.title)}</a></li>`).join("")}</ol>
<p class="full"><a href="${base}/full">Read the entire work on one page</a></p>
<p class="download"><a href="${originalHref(version.r2_prefix)}">Download original epub</a></p>
<p class="report"><a href="${base}/report">Report</a></p>
<p class="unofficial">rarepair is an unofficial stopgap, not the original archive: this copy is here while the original is offline.</p>
<p class="original"><a href="https://archiveofourown.org/works/${work.ao3_work_id}">The original work</a>, where the credit belongs. The link works again once the original archive is back.</p>`,
  );
}

/** `GET /works/:id`: the work page, or the not-found page when no live work has that ID. */
export async function showWork(c: WorkContext) {
  // Only the plain decimal form names a work: Number() alone also reads "0x3039"
  // and "1.2345e4" as 12345. getLiveWork answers anything past an int4 itself.
  const param = c.req.param("id") ?? "";
  if (!AO3_WORK_ID.test(param)) return c.notFound();
  const id = Number(param);
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    const live = await getLiveWork(db, id);
    if (live) return c.html(workPage(live));
    // Hidden and removed works have their own answer; anything else is no page.
    const withheld = await getWorkAvailability(db, id);
    return withheld ? withheldResponse(c, withheld) : c.notFound();
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
