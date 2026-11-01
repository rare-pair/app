// The shared layout every app page goes through, and the pages built on it:
// the sign-in pages, the Turnstile placeholders (U3 and X1 replace them), the not-found page
// and the static about, terms and privacy pages.

import { TURNSTILE_ORIGIN } from "./security";
import { LINK_LIFETIME_MINUTES } from "./signin";
import { STYLESHEET_PATH } from "./styles";
import { TURNSTILE_ACTIONS } from "./turnstile";
import { EPUB_TYPE, MAX_UPLOAD_MB } from "./upload-limit";

export const TURNSTILE_API = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;

/**
 * Text made safe for element content or a quoted attribute value. Not for a URL
 * attribute (a javascript: URL passes through), an unquoted attribute or a script.
 */
export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * A whole HTML document: skip link, temporary banner, header, one chrome h1 made
 * from the title, the body inside main, then the footer. The title is escaped.
 * The body and head are trusted markup from the caller (this file or a page
 * module), never escaped; every caller escapes any value it puts in them, except the
 * chapter fragments of reader.ts and full.ts, which are trusted only because the
 * sanitizer wrote them. So is `heading`, which replaces the default h1 for a page
 * whose one h1 sits in other chrome, such as the reader's top bar.
 */
export const layout = (
  title: string,
  body: string,
  head = "",
  heading = `<h1>${escapeHtml(title)}</h1>`,
) => {
  const { before, after } = layoutAround(title, head, heading);
  return `${before}${body}${after}`;
};

/**
 * The layout's markup before the body and after it, for a page that streams its body
 * (the entire work). Same arguments and trust as `layout`, which is built on it.
 */
export const layoutAround = (
  title: string,
  head = "",
  heading = `<h1>${escapeHtml(title)}</h1>`,
) => ({
  before: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · rarepair</title><link rel="stylesheet" href="${STYLESHEET_PATH}">${head}</head>
<body>
<a class="skip" href="#main">Skip to the main content</a>
<aside class="banner" aria-label="Notice">rarepair is an unofficial, temporary stopgap. <a href="/about">About this site</a></aside>
<header><a class="site-name" href="/">rarepair</a></header>
<main id="main">
${heading}
`,
  after: `
</main>
<footer><a href="/remove">Remove my work</a> · <a href="/about">About</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</body>
</html>`,
});

/** A page with a Turnstile check: the challenge script carries the page nonce. */
export const turnstilePage = (title: string, nonce: string) =>
  layout(
    title,
    `<noscript><p>This page needs JavaScript for its anti-spam check. Reading works without it.</p></noscript>`,
    `<script src="${TURNSTILE_API}" nonce="${escapeHtml(nonce)}" async defer></script>`,
  );

/** The search box, shared by the home page and the not-found page. */
export const SEARCH_FORM = `<form role="search" method="get" action="/search">
<label for="q">Search the archive</label>
<input type="search" id="q" name="q">
<button type="submit">Search</button>
</form>`;

export const notFoundPage = () =>
  layout(
    "Page not found",
    `<p>That page does not exist. Try a search, or go back to <a href="/">the home page</a>.</p>
${SEARCH_FORM}`,
  );

const DRAFT = `<p class="draft">Draft: this text has not been proofread yet.</p>`;

// Drafts for the operator to proof before launch. They describe provenance
// without naming the original archive or its organisation (branding rule).
export const aboutPage = () =>
  layout(
    "About rarepair",
    `${DRAFT}
<p>rarepair is a temporary, community-run reading archive for fanworks. It is an unofficial stopgap, not the original archive, and it is not affiliated with or approved by that archive or the organisation behind it.</p>
<p>People upload the epub files they downloaded from the original archive while it is offline. Anyone can browse and read the works that have been uploaded and accepted. Work pages link back to the original page, and the credit belongs to its author.</p>
<p>Accepted uploads are public. Anyone can ask for a work to be removed, with no need to prove who they are, using the "Remove my work" link in the footer.</p>`,
  );

export const termsPage = () =>
  layout(
    "Terms",
    `${DRAFT}
<p>By creating an account you agree to these terms.</p>
<ul>
<li>You may upload only epub files exported from the original archive, and only works you are happy to have shared.</li>
<li>Uploads that pass our checks are public: anyone can read them.</li>
<li>Anyone can ask for a work to be removed, without proving who they are.</li>
<li>We may hide or remove any work, and close any account, to keep the site safe.</li>
<li>This site is an unofficial, temporary stopgap with no guarantees: it may change or close at any time.</li>
</ul>`,
  );

/**
 * The one-time terms page a new account sees first: a summary, a link to the terms
 * and a button that posts. No script, so it works with JavaScript off. `next` is
 * already reduced to a same-site path.
 */
export const welcomeTermsPage = (next: string) =>
  layout(
    "Before you start",
    `${DRAFT}
<p>Welcome to rarepair. Before you go on, please read <a href="/terms">the terms</a> and accept them.</p>
<p>In short: uploads that pass our checks are public, anyone can ask for a work to be removed, and we may remove any work or close any account to keep the site safe. The site is an unofficial, temporary stopgap that may change or close at any time.</p>
<form method="post" action="/welcome/terms">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">I accept the terms</button>
</form>`,
  );

export const privacyPage = () =>
  layout(
    "Privacy",
    `${DRAFT}
<p>This is what we keep about you.</p>
<ul>
<li>Signing in uses an email link. We keep your email address and no password. Each session also keeps the network address and browser (user agent) it was started from, for as long as the session lasts.</li>
<li>Accepted uploads are public. We do not publish your email address.</li>
<li>Removal and opt-out requests keep a hashed form of the requester's network address, to limit abuse.</li>
<li>The wait list: before launch, if you join it, we keep only your email address, hashed confirmation and unsubscribe tokens and the times we emailed you. We send you a confirmation email, and one launch email. We delete the list once the launch emails have been sent, or sooner if you unsubscribe.</li>
<li>We store the settings and reading position you save, to bring them back next time.</li>
<li>Our anti-spam check, provided by Cloudflare, runs on the sign-in, upload and removal pages and, before launch, on the wait list form on the coming-soon home page.</li>
</ul>`,
  );

export interface SignInForm {
  /** The Turnstile widget's site key. */
  siteKey: string;
  /** Where to go after signing in, already reduced to a same-site path. */
  next: string;
  /** What the visitor typed, when the form comes back to them. */
  email?: string;
  /** Why the form came back. */
  error?: string;
}

/**
 * The sign-in form, with Turnstile alongside. The form starts `hidden` and a
 * nonced script shows it, so without JavaScript there is only the `<noscript>`
 * message and nothing to submit: the request could never pass Turnstile anyway.
 */
export const signInPage = (nonce: string, form: SignInForm) =>
  layout(
    "Sign in",
    `${form.error === undefined ? "" : `<p role="alert">${escapeHtml(form.error)}</p>`}
<noscript><p>Signing in needs JavaScript, for its anti-spam check. Reading works without it.</p></noscript>
<form id="sign-in" method="post" action="/login" hidden>
<label for="email">Email address</label>
<input id="email" type="email" name="email" autocomplete="email" maxlength="254" required value="${escapeHtml(form.email ?? "")}">
<input type="hidden" name="next" value="${escapeHtml(form.next)}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(form.siteKey)}" data-action="${TURNSTILE_ACTIONS.login}"></div>
<button type="submit">Email me a sign-in link</button>
</form>
<script nonce="${escapeHtml(nonce)}">document.getElementById("sign-in").hidden = false;</script>
<p>We'll email you a link that signs you in. It can take a minute to arrive during busy periods.</p>`,
    `<script src="${TURNSTILE_API}" nonce="${escapeHtml(nonce)}" async defer></script>`,
  );

/**
 * The upload page, signed in. Like the sign-in form it starts `hidden` and a nonced
 * script shows it. It is no form: the page's script asks `POST /uploads` for a URL and
 * PUTs the file to R2 itself, so without JavaScript nothing on it can send a file.
 */
export const uploadPage = (nonce: string, siteKey: string) =>
  layout(
    "Upload a work",
    `<noscript><p>Uploading needs JavaScript, for its anti-spam check and to send the file. Reading works without it.</p></noscript>
<div id="upload" hidden>
<label for="file">EPUB files, ${MAX_UPLOAD_MB} MB at most each</label>
<input id="file" type="file" name="file" accept=".epub,${EPUB_TYPE}" multiple>
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTIONS.upload}"></div>
<button type="button">Upload</button>
</div>
<script nonce="${escapeHtml(nonce)}">document.getElementById("upload").hidden = false;</script>`,
    `<script src="${TURNSTILE_API}" nonce="${escapeHtml(nonce)}" async defer></script>`,
  );

/** After a sign-in request: what happens next. */
export const checkEmailPage = () =>
  layout(
    "Check your email",
    `<p>We've sent you a sign-in link. It lasts ${LINK_LIFETIME_MINUTES} minutes.</p>
<p>The link can take a minute to arrive during busy periods.</p>`,
  );

/** A form posted from somewhere other than this site. */
export const forbiddenPage = () =>
  layout(
    "Request refused",
    `<p>That request didn't come from rarepair. <a href="/login">Sign in here</a>.</p>`,
  );

/**
 * The emailed link's page: only a button that posts the token. Opening the link
 * uses nothing up, so a mail scanner's prefetch can't spend it. No script, so it
 * works with JavaScript off. `next` is already reduced to a same-site path.
 */
export const confirmPage = (token: string, next: string) =>
  layout(
    "Sign in",
    `<form method="post" action="/login/confirm">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Sign in</button>
</form>`,
  );

/**
 * Signing in failed on our side, not the link's. The link may already be spent
 * (Better Auth uses it up before it makes the session), so it asks for a new one.
 */
export const signInFailedPage = () =>
  layout(
    "Something went wrong",
    `<p>Signing in didn't work, and it isn't anything you did. <a href="/login">Request a new sign-in link</a> and try again.</p>`,
  );

/**
 * A request over a rate limit, shared by every limited route: when to try again,
 * in the same whole number of seconds as the response's `Retry-After`.
 */
export const tooManyRequestsPage = (seconds: number) =>
  layout(
    "Too many requests",
    `<p>There have been too many requests in a short time. Please try again in ${seconds === 1 ? "1 second" : `${seconds} seconds`}.</p>`,
  );
