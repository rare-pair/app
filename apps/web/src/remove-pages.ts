// The removal form's pages (ARCHITECTURE, Author requests & takedowns): the form and its
// 400, 413 and 503 answers, and the confirmation. Draft copy, for the operator to proof.

import { escapeHtml, layout, TURNSTILE_API } from "./pages";
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

const DRAFT = `<p class="draft">Draft: this text has not been proofread yet.</p>`;

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
    `<script src="${TURNSTILE_API}" nonce="${n}" async defer></script>`,
  );
};

/**
 * After a request that passed its checks. It says nothing of the work, of whether anything
 * was hidden, or of who asked, so it reads the same however the request was handled.
 */
export const removeReceivedPage = () =>
  layout(
    "Request received",
    `${DRAFT}
<p>Your request was received; a moderator will review it and email you.</p>`,
  );
