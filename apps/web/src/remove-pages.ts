// The removal form's pages (ARCHITECTURE, Author requests & takedowns): the form and its
// 400, 413 and 503 answers, and the confirmation. Draft copy, for the operator to proof.

import { siteCard } from "./cards";
import { DRAFT, escapeHtml, layout, TURNSTILE_API } from "./pages";
import { TURNSTILE_ACTIONS } from "./turnstile";

/** The longest statement kept, in characters, as the form says. */
export const MAX_STATEMENT = 2000;
/** The longest pseud accepted, in characters. Far over any real pseud. */
export const MAX_PSEUD = 100;
/** The longest work address accepted, in characters. */
export const MAX_WORK = 500;

/** The fields that can be marked as wrong. */
export type RemoveField = "email" | "work" | "pseud" | "statement";

export interface RemoveForm {
  /** What the visitor typed, or the prefill, put back in the form. */
  values?: Partial<Record<RemoveField, string>>;
  /** A fault with the form as a whole, such as a failed anti-spam check. */
  error?: string;
  /** A fault with one field: it is marked and the message tied to it. */
  fieldErrors?: Partial<Record<RemoveField, string>>;
}

/**
 * The removal request form. It starts `hidden` and a nonced script shows it, as the
 * sign-in form does, so without JavaScript there is only the `<noscript>` message and
 * nothing to submit: the post could never pass Turnstile anyway. Every value is escaped;
 * `moderators` is the contact address, set in wrangler.jsonc.
 */
export const removePage = (
  nonce: string,
  siteKey: string,
  moderators: string,
  form: RemoveForm = {},
) => {
  const values = form.values ?? {};
  const errors = form.fieldErrors ?? {};
  const n = escapeHtml(nonce);
  /** The attributes that mark a field wrong and tie it to its message. */
  const marked = (field: RemoveField) =>
    errors[field] === undefined ? "" : ` aria-invalid="true" aria-describedby="${field}-error"`;
  const message = (field: RemoveField) =>
    errors[field] === undefined
      ? ""
      : `<p class="field-error" id="${field}-error">${escapeHtml(errors[field])}</p>\n`;
  const value = (field: RemoveField) =>
    values[field] ? ` value="${escapeHtml(values[field])}"` : "";
  const alert =
    form.error !== undefined
      ? `<p role="alert">${escapeHtml(form.error)}</p>\n`
      : Object.keys(errors).length > 0
        ? `<p role="alert">Some details need fixing. They are marked below.</p>\n`
        : "";
  return layout(
    "Ask for a work to be removed",
    `${DRAFT}
${alert}<noscript><p>This form needs JavaScript, for its anti-spam check. To ask for something to be removed without it, email the moderators at ${escapeHtml(moderators)}.</p></noscript>
<p>Tell the moderators which work you want removed, or the pseud whose works you want removed. No proof of identity is asked for, because there is nothing to check it against while the original archive is offline. A moderator reviews every request.</p>
<form id="remove" class="remove-form" method="post" action="/remove" hidden>
<label for="email">Your email address</label>
${message("email")}<input id="email" type="email" name="email" autocomplete="email" maxlength="254" required${value("email")}${marked("email")}>
<label for="work">The work's web address, here or at the original archive</label>
${message("work")}<input id="work" type="text" name="work" inputmode="url" maxlength="${MAX_WORK}"${value("work")}${marked("work")}>
<label for="pseud">Or a pseud, to remove every work by it</label>
${message("pseud")}<input id="pseud" type="text" name="pseud" maxlength="${MAX_PSEUD}"${value("pseud")}${marked("pseud")}>
<label for="statement">A short statement (optional, up to ${MAX_STATEMENT} characters)</label>
${message("statement")}<textarea id="statement" name="statement" rows="6" maxlength="${MAX_STATEMENT}"${marked("statement")}>
${escapeHtml(values.statement ?? "")}</textarea>
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTIONS.remove}"></div>
<button type="submit">Send request</button>
</form>
<script nonce="${n}">document.getElementById("remove").hidden = false;</script>`,
    `<script src="${TURNSTILE_API}" nonce="${n}" async defer></script>${siteCard()}`,
  );
};

/**
 * After a request that passed its checks. It says nothing of the work, of whether anything
 * was hidden, or of who asked, so it reads the same however the request was handled. It
 * sends the requester to their inbox: nothing happens until they confirm.
 */
export const removeReceivedPage = () =>
  layout(
    "Check your email",
    `${DRAFT}
<p>Check your email: we've sent a link to the address you gave. Open it and press the button to confirm your request. The link works once, for 7 days, and nothing happens until you confirm.</p>`,
  );

/**
 * The emailed link's page: only a button that posts the token. Opening the link changes
 * nothing, so a mail scanner's prefetch can't confirm a request. No script, so it works
 * with JavaScript off. The token is the one thing the page echoes, escaped. It says nothing
 * of the work.
 */
export const requestConfirmPage = (token: string) =>
  layout(
    "Confirm your request",
    `${DRAFT}
<form method="post" action="/remove/confirm">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<p>Press the button to confirm your request.</p>
<button type="submit">Confirm</button>
</form>`,
  );

/**
 * After a confirmation that matched. It reads the same whatever the work's status and
 * whether anything was hidden, and never shows the address.
 */
export const removeConfirmedPage = () =>
  layout(
    "Request confirmed",
    `${DRAFT}
<p>Your request is confirmed. A moderator will review it and email you.</p>`,
  );

/** A used, expired or unknown confirmation link, or none at all. */
export const removeLinkRefusedPage = () =>
  layout(
    "That link doesn't work",
    `${DRAFT}
<p>That confirmation link has already been used or has expired, or it was never valid. Links work once, for 7 days. You can <a href="/remove">send the request again</a> to get a new one.</p>`,
  );

/** The confirmation email couldn't be queued, and the request was not kept. */
export const removeUnavailablePage = () =>
  layout(
    "Something went wrong",
    `${DRAFT}
<p>We couldn't send your confirmation email just now, so your request was not kept. Please <a href="/remove">try again</a> in a minute.</p>`,
  );

/**
 * After a request for a work the archive doesn't hold: nothing was stored. It is the one
 * answer that differs from `removeReceivedPage`, and says so, since there is nothing for a
 * moderator to review. It points to the opt-out, which removes a pseud's works whether or
 * not they have been uploaded yet.
 */
export const removeNotHeldPage = () =>
  layout(
    "Not in the archive",
    `${DRAFT}
<p>That work isn't in the archive, so there is nothing to remove, and no request was stored.</p>
<p>To keep a pseud's works out of the archive, <a href="/remove">ask for the pseud to be removed</a> instead.</p>`,
  );
