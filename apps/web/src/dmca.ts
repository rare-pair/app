// The DMCA notice form, `/dmca` (ARCHITECTURE, Author requests & takedowns, DMCA). Public,
// with no sign-in, no script and no Turnstile, so it works with JavaScript off. Its abuse
// control is a rate limit per client address. A notice is stored for a moderator and never
// hides the work: only a moderator's decision does. A notice missing a statutory element
// (17 U.S.C. 512(c)(3)(A)) is stored too, marked incomplete.

import { createDb } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { escapeHtml, layout } from "./pages";
import { DMCA_WINDOW_SECONDS, ipKey, isLimited, tooManyRequests } from "./rate-limit";
import type { SecurityVariables } from "./security";

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
 * The form. Every typed value is escaped. A form that comes back keeps what was typed, so
 * nothing is lost to a mistake in the work's address.
 */
const dmcaPage = (notice: Notice = emptyNotice, error?: string) =>
  layout(
    "Copyright notice",
    `<p class="draft">Draft: this text has not been proofread yet.</p>
${error === undefined ? "" : `<p role="alert">${escapeHtml(error)}</p>\n`}<p>Use this form to tell us that a work here infringes your copyright. A notice that leaves something out is still kept, and a moderator looks at it, but it may not be enough for us to act on. This is not legal advice.</p>
<form class="dmca-form" method="post" action="/dmca">
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
<label class="check"><input type="checkbox" name="good_faith" value="yes"${notice.goodFaith ? " checked" : ""}> I have a good-faith belief that the use of the material in the way I complain of is not authorised by the copyright owner, its agent or the law.</label>
<label class="check"><input type="checkbox" name="accuracy_authority" value="yes"${notice.accuracyAuthority ? " checked" : ""}> The information in this notice is accurate, and, under penalty of perjury, I am the copyright owner or authorised to act for the owner.</label>
<label for="signature">Your full name, as your signature</label>
<input id="signature" name="signature" type="text" maxlength="${MAX_SIGNATURE}" value="${escapeHtml(notice.signature)}">
<button type="submit">Send notice</button>
</form>`,
  );

/** What happens next. Draft copy. */
const receivedPage = () =>
  layout(
    "Notice received",
    `<p class="draft">Draft: this text has not been proofread yet.</p>
<p>Thank you. A moderator will look at your notice. The work stays up until a moderator has decided.</p>`,
  );

/** `GET /dmca`: the form, for anyone. */
export const showDmcaForm = (c: DmcaContext) => c.html(dmcaPage(), 200, NO_STORE);

/** Each text field, with line breaks as one (a browser sends CRLF) and NULs, which Postgres text can't hold, dropped. */
const text = (form: URLSearchParams, name: string) =>
  (form.get(name) ?? "").replaceAll("\r\n", "\n").replaceAll("\u0000", "");

/**
 * `POST /dmca`, behind `sameOriginOnly`: stores a notice. The client's limit is counted
 * before the body is read, so a flood costs neither.
 */
export async function submitDmca(c: DmcaContext) {
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  if (await isLimited(c.env.DMCA_IP_LIMIT, await ipKey("dmca", clientIp))) {
    return tooManyRequests(DMCA_WINDOW_SECONDS);
  }

  const form = await readForm(c.req.raw, MAX_DMCA_BODY);
  // Nothing of it is shown back: the form comes again empty.
  if (form === null) {
    const error = "That notice was too large. Please try again.";
    return c.html(dmcaPage(emptyNotice, error), 413, NO_STORE);
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
  const back = (error: string) => c.html(dmcaPage(notice, error), 400, NO_STORE);

  // The server checks, since the page has no script and a form can be posted by hand.
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
      return c.html(dmcaPage(notice, error), 404, NO_STORE);
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
