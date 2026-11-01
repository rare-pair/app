// The report form, `/works/:id/report`, where :id is the AO3 work ID. Reporting
// needs an account (ARCHITECTURE, Author requests & takedowns, Reports). No
// script and no Turnstile, so it works with JavaScript off.

import { createDb } from "@archive/db";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { escapeHtml, forbiddenPage, layout } from "./pages";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { isSameOrigin } from "./signin";

type ReportContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

type Db = ReturnType<typeof createDb>;

const MAX_INT4 = 2_147_483_647;

/**
 * The reasons a reader can give, by the `kind` stored. Only `wrong_version` is
 * named in the docs: moderators' *Works to check* and the auto-hide count read it
 * by that string. The labels are draft copy.
 */
const REASONS = {
  wrong_version: "This version is wrong",
  harmful_content: "It breaks the rules or is harmful",
  not_this_work: "It isn't the work it says it is",
  other: "Something else",
} as const;

/** An AO3 work ID from the URL: plain decimal digits, within Postgres's int4. */
export function workId(text: string | undefined): number | null {
  if (text === undefined || !/^[1-9]\d{0,9}$/.test(text)) return null;
  const value = Number(text);
  return value <= MAX_INT4 ? value : null;
}

/** A live work, as the work page would show it, or undefined. Hidden and removed works are not found. */
const liveWork = (db: Db, ao3WorkId: number) =>
  db
    .selectFrom("works")
    .select(["id", "title"])
    .where("ao3_work_id", "=", ao3WorkId)
    .where("status", "=", "live")
    .where("current_version_id", "is not", null)
    .executeTakeFirst();

/**
 * Whether the account is banned. Read from the database, not the session: the
 * session's user has no `banned_at`, and a ban must hold at once. An account with
 * no row can't report either.
 */
const isBanned = async (db: Db, userId: string) => {
  const user = await db
    .selectFrom("user")
    .select("banned_at")
    .where("id", "=", userId)
    .executeTakeFirst();
  return user === undefined || user.banned_at !== null;
};

/** Report pages that hold what the reader typed, or depend on who they are, stay out of caches. */
const NO_STORE = { "Cache-Control": "no-store" };

const bannedPage = () =>
  layout("Reporting is closed", `<p>You can't send reports from this account.</p>`);

type Kind = keyof typeof REASONS;

const isKind = (value: string): value is Kind => Object.hasOwn(REASONS, value);

/** The longest details kept, in characters, as the form says. */
const MAX_DETAILS = 2000;

// The form at its largest, where maxlength counts UTF-16 code units: none encodes
// to more than 9 bytes percent-encoded (a three-byte character; a line break, sent
// as CRLF, is 6), so 2000 come to 18 KB. A browser that counts characters instead
// (Safari counts each emoji as one) can send several times that, so the cap leaves
// room for it: such details get the 400 with what was typed, not a 413 that loses it.
const MAX_REPORT_BODY = 64 * 1024;

interface ReportForm {
  /** Why the form came back. */
  error?: string;
  /** The reason chosen, when the form comes back. */
  kind?: Kind;
  /** What was typed, when the form comes back. */
  details?: string;
}

/** The form. `ao3WorkId` is a number, so safe in an href. Every other value is escaped. */
const reportPage = (ao3WorkId: number, title: string, form: ReportForm = {}) =>
  layout(
    "Report a work",
    `<p class="draft">Draft: this text has not been proofread yet.</p>
${form.error === undefined ? "" : `<p role="alert">${escapeHtml(form.error)}</p>\n`}<p>Tell the moderators what is wrong with <a href="/works/${ao3WorkId}">${escapeHtml(title)}</a>.</p>
<form class="report-form" method="post" action="/works/${ao3WorkId}/report">
<fieldset>
<legend>Reason</legend>
${Object.entries(REASONS)
  .map(
    ([kind, label]) =>
      `<label><input type="radio" name="reason" value="${kind}"${kind === form.kind ? " checked" : ""}> ${escapeHtml(label)}</label>`,
  )
  .join("\n")}
</fieldset>
<label for="details">Details (optional, up to ${MAX_DETAILS} characters)</label>
<textarea id="details" name="details" rows="6" maxlength="${MAX_DETAILS}">
${escapeHtml(form.details ?? "")}</textarea>
<button type="submit">Send report</button>
</form>`,
  );

/** The sign-in form, coming back to work `id`'s report form after. */
const signInFirst = (id: number) => `/login?next=${encodeURIComponent(`/works/${id}/report`)}`;

/**
 * What happens next. A wrong version is checked, and never counts toward hiding
 * the work. It says nothing of how many reports hide a work, which would help
 * anyone gaming it. Draft copy.
 */
const reportedPage = (kind: Kind) =>
  layout(
    "Report sent",
    `<p class="draft">Draft: this text has not been proofread yet.</p>
<p>Thank you. A moderator will look at it. Your report is kept with your account.</p>
${
  kind === "wrong_version"
    ? "<p>A moderator will check this version of the work.</p>"
    : "<p>A work several readers report may be hidden until a moderator has looked at it.</p>"
}`,
  );

/** `GET /works/:id/report`: the form, for a signed-in reader. */
export async function showReportForm(c: ReportContext) {
  const id = workId(c.req.param("id"));
  if (id === null) return c.notFound();
  const session = c.var.session;
  if (session === null) return c.redirect(signInFirst(id), 302);
  // Its queries run one after another, so one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const work = await liveWork(db, id);
    if (!work) return c.notFound();
    if (await isBanned(db, session.user.id)) return c.html(bannedPage(), 403, NO_STORE);
    return c.html(reportPage(id, work.title), 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}

/**
 * Refuses a form posted from anywhere but the site, as the sign-in forms do. It
 * goes before the session middleware, so a cross-site post costs no session lookup.
 */
export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (!isSameOrigin(c.req.raw.headers)) return c.html(forbiddenPage(), 403, NO_STORE);
  await next();
};

/**
 * `POST /works/:id/report`, behind `sameOriginOnly`: stores an open report. A
 * signed-out post is sent to sign in before its body is read. The work and the
 * ban are checked once the body is in, so a slow body can't outlast either.
 */
export async function submitReport(c: ReportContext) {
  const id = workId(c.req.param("id"));
  if (id === null) return c.notFound();
  const session = c.var.session;
  if (session === null) return c.redirect(signInFirst(id), 303);

  const form = await readForm(c.req.raw, MAX_REPORT_BODY);
  // Its queries run one after another, so one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const work = await liveWork(db, id);
    if (!work) return c.notFound();
    if (await isBanned(db, session.user.id)) return c.html(bannedPage(), 403, NO_STORE);

    // Nothing of it is shown back: the form comes again empty.
    if (form === null) {
      const error = "That report was too large. Please try again.";
      return c.html(reportPage(id, work.title, { error }), 413, NO_STORE);
    }
    const reason = form.get("reason") ?? "";
    // A browser submits each line break as CRLF, but the form's maxlength counts it as one.
    // A NUL is never typed, and Postgres text can't hold one.
    const details = (form.get("details") ?? "").replaceAll("\r\n", "\n").replaceAll("\u0000", "");
    // The server checks, since the page has no script and a form can be posted by hand.
    if (!isKind(reason)) {
      return c.html(
        reportPage(id, work.title, { error: "Choose a reason.", details }),
        400,
        NO_STORE,
      );
    }
    if (details.length > MAX_DETAILS) {
      const error = `Details can be up to ${MAX_DETAILS} characters.`;
      return c.html(reportPage(id, work.title, { error, kind: reason, details }), 400, NO_STORE);
    }
    await db
      .insertInto("reports")
      .values({
        work_id: work.id,
        reporter_id: session.user.id,
        kind: reason,
        // Optional: details left empty, or only spaces, are none.
        body: details.trim() === "" ? null : details,
      })
      .execute();
    return c.html(reportedPage(reason), 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
