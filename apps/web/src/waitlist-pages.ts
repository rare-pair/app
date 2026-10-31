// The wait list's pages (ARCHITECTURE, Wait list), the only ones with web fonts.
// They go through the shared layout, with the wait list stylesheet after the site's.
// The other wait list pages (WL2, WL3) reuse waitlistPage.
//
// Draft copy, written from specs/scenarios/mvp/22-waitlist.md for the operator to proof.

import { escapeHtml, layout, TURNSTILE_API } from "./pages";
import { TURNSTILE_ACTIONS } from "./turnstile";

// Served from public/ by assetRoute. The names carry each file's content hash.
const WAITLIST_STYLESHEET_PATH = "/assets/waitlist/waitlist.81645bab20ed0f3f.css";
const FRAUNCES_LICENCE = "/assets/waitlist/fonts/fraunces/OFL.txt";
const PLEX_LICENCE = "/assets/waitlist/fonts/ibm-plex-mono/license.txt";

/**
 * A whole wait list page: the shared layout, set in the wait list's web fonts, with
 * their licences linked. Put a wait list form in a .waitlist form for its styles. The
 * layout escapes the title; the body and head are trusted markup, never escaped:
 * escape any value first.
 */
export const waitlistPage = (title: string, body: string, head = "") =>
  layout(
    title,
    `${body}
<p class="note">Set in Fraunces (<a href="${FRAUNCES_LICENCE}">licence</a>) and IBM Plex Mono (<a href="${PLEX_LICENCE}">licence</a>).</p>`,
    `<link rel="stylesheet" href="${WAITLIST_STYLESHEET_PATH}">${head}`,
  );

/**
 * The coming-soon page at / while PRELAUNCH is on, with the wait list form. Its button
 * starts disabled and only Turnstile's callbacks enable it, so without JavaScript (and
 * so without a token) the form can't be submitted at all, not even with Enter. A
 * refused `POST /waitlist` shows it again with what was typed and an error.
 */
export const comingSoonPage = (
  nonce: string,
  siteKey: string,
  form: { email?: string; error?: string } = {},
) => {
  const n = escapeHtml(nonce);
  return waitlistPage(
    "rarepair is coming soon",
    `<p>A temporary, community-run reading archive for fanworks. Upload the epub files you downloaded, and anyone can browse, search and read them in the browser.</p>
${form.error === undefined ? "" : `<p role="alert">${escapeHtml(form.error)}</p>\n`}<form class="waitlist" method="post" action="/waitlist">
<label for="email">Email address</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254" required${form.email ? ` value="${escapeHtml(form.email)}"` : ""}>
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTIONS.waitlist}" data-callback="waitlistReady" data-expired-callback="waitlistExpired"></div>
<button id="join" type="submit" disabled>Join the wait list</button>
</form>
<noscript><p>Joining the wait list needs JavaScript, for its anti-spam check.</p></noscript>
<p class="note">Your address gets one email when the archive opens, and nothing else.</p>`,
    `<script nonce="${n}">
function waitlistReady() { document.getElementById("join").disabled = false; }
function waitlistExpired() { document.getElementById("join").disabled = true; }
</script>
<script src="${TURNSTILE_API}" nonce="${n}" async defer></script>`,
  );
};

/**
 * After a `POST /waitlist` that passed its checks, whether or not the address was on the
 * list already, so the form can't tell anyone who is. It never shows the address.
 */
export const waitlistCheckEmailPage = () =>
  waitlistPage(
    "Check your email to confirm",
    `<p>If that address can join, we've sent it a link to confirm. The link works once, for 7 days, and only the newest one works.</p>
<p>Once you confirm, your address gets one email when the archive opens, and nothing else.</p>`,
  );

/** A wait list form posted from somewhere other than this site. */
export const waitlistForbiddenPage = () =>
  waitlistPage(
    "Request refused",
    `<p>That request didn't come from rarepair. <a href="/">Join the wait list here</a>.</p>`,
  );

/**
 * The emailed link's page: only a button that posts the token. Opening the link uses
 * nothing up, so a mail scanner's prefetch can't spend it. No script, so it works with
 * JavaScript off. The token is the one thing the page echoes, escaped.
 */
export const waitlistConfirmPage = (token: string) =>
  waitlistPage(
    "Confirm your address",
    `<form class="waitlist" method="post" action="/waitlist/confirm">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<p>Press the button to put your address on the wait list.</p>
<button type="submit">Confirm</button>
</form>`,
  );

/** After a confirmation that matched. It never shows the address. */
export const waitlistConfirmedPage = () =>
  waitlistPage(
    "You're on the list",
    `<p>One email will follow when rarepair opens, and nothing else.</p>`,
  );

/** A used, expired or unknown confirmation link, or none at all. */
export const waitlistLinkRefusedPage = () =>
  waitlistPage(
    "That link doesn't work",
    `<p>That confirmation link has already been used or has expired, or it was never valid. Links work once, for 7 days. <a href="/">Join the wait list again</a> for a new one.</p>`,
  );

/**
 * A confirmation link opened after launch (`PRELAUNCH` off): the list is closed. Draft copy,
 * for the operator to proof.
 */
export const waitlistArchiveOpenPage = () =>
  waitlistPage(
    "The archive is open",
    `<p>The archive is open, and the wait list is closed. <a href="/">Go to the archive</a>.</p>`,
  );

/** The confirmation email couldn't be queued, and nothing was kept. */
export const waitlistUnavailablePage = () =>
  waitlistPage(
    "Something went wrong",
    `<p>We couldn't send your confirmation email just now, so nothing was changed. Please <a href="/">try again</a> in a minute.</p>`,
  );

/**
 * The unsubscribe link's page: only a button. Opening the link deletes nothing, so a mail
 * scanner's prefetch can't unsubscribe anyone. The form posts to the same URL, token in
 * the query, as a mail provider's one-click request does. Draft copy, for the operator
 * to proof.
 */
export const waitlistUnsubscribePage = (token: string) =>
  waitlistPage(
    "Unsubscribe",
    `<form class="waitlist" method="post" action="/waitlist/unsubscribe?token=${escapeHtml(token)}">
<p>Press the button to take your address off the wait list.</p>
<button type="submit">Unsubscribe</button>
</form>`,
  );

/** After an unsubscribe, whether or not a row was there. It never shows the address. Draft copy. */
export const waitlistUnsubscribedPage = () =>
  waitlistPage(
    "You're unsubscribed",
    `<p>Your address has been removed from the wait list. We won't email you again.</p>`,
  );

/** An unsubscribe link with no token, or a token of a shape we never issue. Draft copy. */
export const waitlistUnsubscribeRefusedPage = () =>
  waitlistPage(
    "That link doesn't work",
    `<p>That unsubscribe link is incomplete or damaged. Use the link in the email as it was sent.</p>`,
  );
