// The DMCA notice form, `/dmca` (ARCHITECTURE, Author requests & takedowns, DMCA). Public,
// with no sign-in, behind Turnstile, so it needs JavaScript: a visitor without it is told
// where to email a notice. Its abuse controls are the check and a rate limit per client
// address, counted before any check; over it, the form still comes back with what was typed. A notice is stored for a moderator and never
// hides the work: only a moderator's decision does. A notice missing a statutory element
// (17 U.S.C. 512(c)(3)(A)) is stored too, marked incomplete.

import { createDb } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { siteCard } from "./cards";
import { escapeHtml, layout, TURNSTILE_API } from "./pages";
import { DMCA_WINDOW_SECONDS, ipKey, isLimited, tooManyRequests } from "./rate-limit";
import type { SecurityVariables } from "./security";
import { TURNSTILE_ACTIONS, verifyTurnstile } from "./turnstile";

type DmcaContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

const MAX_INT4 = 2_147_483_647;

/** Pages that hold what the requester typed stay out of caches. */
const NO_STORE = { "Cache-Control": "no-store" };

/** The longest a text field may be, in characters, as the form says. */
const MAX_FIELD = 4000;
/** The longest the work's address may be. */
const MAX_WORK = 500;
/** The longest typed signature. */
const MAX_SIGNATURE = 200;

// The form at its largest: three text areas of 4000 characters, each at most 9 bytes
// percent-encoded, is 108 KB, and a browser that counts characters rather than UTF-16 code
// units (Safari counts each emoji as one) can send several times that. The cap leaves
// room, so such a notice gets the 400 with what was typed and not a 413 that loses it.
const MAX_DMCA_BODY = 256 * 1024;

// A work's address here or on the original archive, and no other host: an address on any
// other site names nothing here, and must not be read as if it did.
const WORK_ADDRESS =
  /^(?:https?:\/\/)?(?:www\.)?(?:rarepair\.fans|archiveofourown\.org)\/works\/([1-9]\d{0,9})(?:[/?#]|$)/i;

/**
 * The AO3 work ID a requester named: a bare ID, or an address with `/works/<id>` in it,
 * here or on the original archive. Plain decimal digits, within Postgres's int4.
 */
export function workIdOf(text: string): number | null {
  const reference = text.trim();
  const digits = /^[1-9]\d{0,9}$/.exec(reference)?.[0] ?? WORK_ADDRESS.exec(reference)?.[1];
  if (digits === undefined) return null;
  const value = Number(digits);
  return value <= MAX_INT4 ? value : null;
}

/** The two statements the form has a person tick, as the page without JavaScript gives them to copy. */
const GOOD_FAITH =
  "I have a good-faith belief that the use of the material in the way I complain of is not authorised by the copyright owner, its agent or the law.";
const ACCURACY_AUTHORITY =
  "The information in this notice is accurate, and, under penalty of perjury, I am the copyright owner or authorised to act for the owner.";

/** What was typed in the form, each as sent but with line breaks normalised and NULs dropped. */
interface Notice {
  work: string;
  copyrightedWork: string;
  infringingMaterial: string;
  contact: string;
  signature: string;
  goodFaith: boolean;
  accuracyAuthority: boolean;
}

/** Which of the six elements of 512(c)(3)(A) a notice leaves out, by the name the form gives it. */
export function missingElements(notice: Notice): string[] {
  const blank = (text: string) => text.trim() === "";
  return [
    ...(blank(notice.signature) ? ["signature"] : []),
    ...(blank(notice.copyrightedWork) ? ["copyrighted_work"] : []),
    ...(blank(notice.infringingMaterial) ? ["infringing_material"] : []),
    ...(blank(notice.contact) ? ["contact"] : []),
    ...(notice.goodFaith ? [] : ["good_faith"]),
    ...(notice.accuracyAuthority ? [] : ["accuracy_authority"]),
  ];
}

const emptyNotice: Notice = {
  work: "",
  copyrightedWork: "",
  infringingMaterial: "",
  contact: "",
  signature: "",
  goodFaith: false,
  accuracyAuthority: false,
};

/**
 * How to send a notice by email: what the form asks for, with the two statements in its own
 * words, so a notice sent to `notices` can carry the same elements. Plain text with no
 * markup, for the page without JavaScript and for a refusal. Draft copy.
 */
const byEmail = (notices: string) =>
  `To send a copyright notice by email instead, write to ${escapeHtml(notices)} and include: (1) the work here, by its address or number; (2) the copyrighted work you say is infringed; (3) the material you say infringes it, and where on the work it is; (4) your name, address, telephone number and email address; (5) this statement: ${escapeHtml(GOOD_FAITH)} (6) this statement: ${escapeHtml(ACCURACY_AUTHORITY)} (7) your full name, as your signature. A person reads that mailbox, and a notice sent there does not reach the online queue, so it can take longer to be seen.`;

/** The page without JavaScript: one paragraph, no markup inside it. */
const noscriptMessage = (notices: string) =>
  `This form needs JavaScript, for its anti-spam check. ${byEmail(notices)}`;

/** Under a refusal that stops the form working, so a visitor whose check is blocked can still send a notice. */
const fallbackMessage = (notices: string) =>
  `If the form is not working for you, there is another way. ${byEmail(notices)}`;

/** What a page of the form shows besides its fields: what was typed, an error, and the email fallback. */
interface PageState {
  notice?: Notice;
  error?: string;
  fallback?: boolean;
}

/**
 * The form. Every typed value is escaped. A form that comes back keeps what was typed, so
 * nothing is lost to a mistake in the work's address, and shows a fresh widget, since a
 * token is spent once. It stays hidden until a nonced script shows it, so without
 * JavaScript nothing can be submitted.
 */
const dmcaPage = (
  { nonce, siteKey, notices }: { nonce: string; siteKey: string; notices: string },
  { notice = emptyNotice, error, fallback = false }: PageState = {},
) =>
  layout(
    "Copyright notice",
    `${error === undefined ? "" : `<p role="alert">${escapeHtml(error)}</p>\n`}${fallback ? `<p>${fallbackMessage(notices)}</p>\n` : ""}<noscript><p>${noscriptMessage(notices)}</p></noscript>
<form id="dmca" class="dmca-form" method="post" action="/dmca" hidden>
<p>Use this form to tell us that a work here infringes your copyright. A notice that leaves something out is still kept, and a moderator looks at it, but it may not be enough for us to act on. This is not legal advice.</p>
<label for="work">The work here (its address, or its number)</label>
<input id="work" name="work" type="text" maxlength="${MAX_WORK}" required value="${escapeHtml(notice.work)}">
<label for="copyrighted_work">The copyrighted work you say is infringed (up to ${MAX_FIELD} characters)</label>
<textarea id="copyrighted_work" name="copyrighted_work" rows="4" maxlength="${MAX_FIELD}">
${escapeHtml(notice.copyrightedWork)}</textarea>
<label for="infringing_material">The material you say infringes it, and where on the work it is (up to ${MAX_FIELD} characters)</label>
<textarea id="infringing_material" name="infringing_material" rows="4" maxlength="${MAX_FIELD}">
${escapeHtml(notice.infringingMaterial)}</textarea>
<label for="contact">Your name, address, telephone number and email address (up to ${MAX_FIELD} characters)</label>
<textarea id="contact" name="contact" rows="4" maxlength="${MAX_FIELD}">
${escapeHtml(notice.contact)}</textarea>
<label class="check"><input type="checkbox" name="good_faith" value="yes"${notice.goodFaith ? " checked" : ""}> ${escapeHtml(GOOD_FAITH)}</label>
<label class="check"><input type="checkbox" name="accuracy_authority" value="yes"${notice.accuracyAuthority ? " checked" : ""}> ${escapeHtml(ACCURACY_AUTHORITY)}</label>
<label for="signature">Your full name, as your signature</label>
<input id="signature" name="signature" type="text" maxlength="${MAX_SIGNATURE}" value="${escapeHtml(notice.signature)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTIONS.dmca}"></div>
<button type="submit">Send notice</button>
</form>
<script nonce="${escapeHtml(nonce)}">document.getElementById("dmca").hidden = false;</script>`,
    `<script src="${TURNSTILE_API}" nonce="${escapeHtml(nonce)}" async defer></script>${siteCard()}`,
  );

/** What happens next. Draft copy. */
const receivedPage = () =>
  layout(
    "Notice received",
    `<p>Thank you. A moderator will look at your notice. The work stays up until a moderator has decided.</p>`,
  );

/** `GET /dmca`: the form, for anyone. */
export const showDmcaForm = (c: DmcaContext) =>
  c.html(
    dmcaPage({
      nonce: c.get("nonce"),
      siteKey: c.env.TURNSTILE_SITE_KEY,
      notices: c.env.NOTICES_EMAIL,
    }),
    200,
    NO_STORE,
  );

/** Each text field, with line breaks as one (a browser sends CRLF) and NULs, which Postgres text can't hold, dropped. */
const text = (form: URLSearchParams, name: string) =>
  (form.get(name) ?? "").replaceAll("\r\n", "\n").replaceAll("\u0000", "");

/**
 * `POST /dmca`, behind `sameOriginOnly`: stores a notice, once its Turnstile token
 * passes. The client's limit is counted first, before any check. Every refusal, the limit's
 * 429 included, gives the form back with what was typed and a fresh widget.
 */
export async function submitDmca(c: DmcaContext) {
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  const limited = await isLimited(c.env.DMCA_IP_LIMIT, await ipKey("dmca", clientIp));

  const where = {
    nonce: c.get("nonce"),
    siteKey: c.env.TURNSTILE_SITE_KEY,
    notices: c.env.NOTICES_EMAIL,
  };
  const page = (state: PageState) => dmcaPage(where, state);

  // The body is bounded, so it is read even when the client is over its limit: a long notice
  // comes back in the form instead of being lost. One too large for that gets the plain 429.
  const form = await readForm(c.req.raw, MAX_DMCA_BODY);
  // A post with no fields (another content type, no body) has nothing to keep either.
  if (limited && (form === null || form.size === 0)) return tooManyRequests(DMCA_WINDOW_SECONDS);
  // Nothing of it is shown back: the form comes again empty.
  if (form === null) {
    const error = "That notice was too large. Please try again.";
    return c.html(page({ error }), 413, NO_STORE);
  }
  const notice: Notice = {
    work: text(form, "work"),
    copyrightedWork: text(form, "copyrighted_work"),
    infringingMaterial: text(form, "infringing_material"),
    contact: text(form, "contact"),
    signature: text(form, "signature"),
    goodFaith: form.get("good_faith") === "yes",
    accuracyAuthority: form.get("accuracy_authority") === "yes",
  };
  const back = (error: string) => c.html(page({ notice, error }), 400, NO_STORE);

  if (limited) {
    // Only as much as the form takes, so a rejected post can't make a page of its own size.
    const kept: Notice = {
      ...notice,
      work: notice.work.slice(0, MAX_WORK),
      copyrightedWork: notice.copyrightedWork.slice(0, MAX_FIELD),
      infringingMaterial: notice.infringingMaterial.slice(0, MAX_FIELD),
      contact: notice.contact.slice(0, MAX_FIELD),
      signature: notice.signature.slice(0, MAX_SIGNATURE),
    };
    const wait = DMCA_WINDOW_SECONDS;
    const error = `Too many requests in a short time. Your notice is kept below: please try again in ${wait} seconds.`;
    return c.html(page({ notice: kept, error, fallback: true }), 429, {
      ...NO_STORE,
      "Retry-After": String(wait),
    });
  }

  // Before any field is looked at, so nothing is stored or answered for a post that isn't
  // solved; what was typed still comes back.
  const turnstile = await verifyTurnstile(form.get("cf-turnstile-response"), {
    secret: c.env.TURNSTILE_SECRET_KEY,
    hostname: new URL(c.req.url).hostname,
    action: TURNSTILE_ACTIONS.dmca,
    remoteIp: clientIp,
  });
  if (turnstile === "failed") {
    const error = "The anti-spam check did not pass. Please try again.";
    return c.html(page({ notice, error, fallback: true }), 400, NO_STORE);
  }
  if (turnstile === "unavailable") {
    const error = "The anti-spam check is not answering just now. Please try again in a minute.";
    return c.html(page({ notice, error, fallback: true }), 503, NO_STORE);
  }

  // The server checks, since a form can be posted by hand.
  if (notice.work.length > MAX_WORK) return back(`The work can be up to ${MAX_WORK} characters.`);
  const tooLong = [notice.copyrightedWork, notice.infringingMaterial, notice.contact].some(
    (field) => field.length > MAX_FIELD,
  );
  if (tooLong) return back(`Each field can be up to ${MAX_FIELD} characters.`);
  if (notice.signature.length > MAX_SIGNATURE) {
    return back(`The signature can be up to ${MAX_SIGNATURE} characters.`);
  }
  const ao3WorkId = workIdOf(notice.work);
  if (ao3WorkId === null) return back("Give the work's address or number.");

  // Its queries run one after another, so one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    // Any status: a notice on a hidden or removed work is still kept.
    const work = await db
      .selectFrom("works")
      .select("id")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirst();
    if (!work) {
      // The form comes back with what was typed, so a mistaken address costs no retyping.
      const error = "That work is not in the archive, so nothing was sent.";
      return c.html(page({ notice, error }), 404, NO_STORE);
    }
    await db
      .insertInto("takedowns")
      .values({
        work_id: work.id,
        requester: notice.contact.trim(),
        basis: notice.copyrightedWork.trim(),
        signature: notice.signature.trim(),
        infringing_material: notice.infringingMaterial.trim(),
        good_faith: notice.goodFaith,
        accuracy_authority: notice.accuracyAuthority,
        incomplete: missingElements(notice).length > 0,
      })
      .execute();
    return c.html(receivedPage(), 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
