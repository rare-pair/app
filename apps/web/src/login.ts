import { createDb } from "@archive/db";
import { isAPIError } from "better-auth/api";
import type { Context } from "hono";
import { makeAuth } from "./auth";
import type { Bindings } from "./env";
import { checkEmailPage, forbiddenPage, signInPage } from "./pages";
import { emailKey, ipKey, isLimited, LOGIN_WINDOW_SECONDS, tooManyRequests } from "./rate-limit";
import type { SecurityVariables } from "./security";
import { isSameOrigin, safeNext } from "./signin";
import { TURNSTILE_ACTIONS, verifyTurnstile } from "./turnstile";

// The longest address an email can be sent to (RFC 5321), as apps/mailer checks.
export const MAX_EMAIL = 254;

// For the form shown again after a refusal: it can hold what was typed, so no cache keeps it.
export const NO_STORE = { "Cache-Control": "no-store" };

type LoginContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

/** Better Auth's code for a sign-in link that was used, has expired or was never issued. */
export const INVALID_TOKEN = "INVALID_TOKEN";

// What `GET /login?error=INVALID_TOKEN` says. Any other value says nothing, and none is shown back.
const LINK_REFUSED = "That sign-in link was used or has expired. Request a new one.";

/** `GET /login`: the sign-in form, carrying the page to come back to. */
export const showSignIn = (c: LoginContext) =>
  c.html(
    signInPage(c.get("nonce"), {
      siteKey: c.env.TURNSTILE_SITE_KEY,
      next: safeNext(c.req.query("next") ?? null),
      error: c.req.query("error") === INVALID_TOKEN ? LINK_REFUSED : undefined,
    }),
  );

// The sign-in form at its largest, every character percent-encoded at its widest:
// a 254-character address and a 512-character next (up to 9 bytes each, as
// UTF-8) and a 2048-character Turnstile token (3 each) come to about 13 KB. The
// wait list form, the same without `next`, is smaller, and so is the confirm form
// (a sign-in token of at most 256 characters and `next`: about 7 KB).
const MAX_BODY = 16 * 1024;

/**
 * The fields of a plain form post, or null when the body is over `maxBytes`
 * bytes, which stops being read there, or breaks off. Anything else, such as a
 * multipart body, has no fields and is never read.
 */
export async function readForm(
  request: Request,
  maxBytes = MAX_BODY,
): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return new URLSearchParams();
  }
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (request.body === null) return new URLSearchParams();

  // Counted as it arrives, since a streamed body declares no length.
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength;
      if (size > maxBytes) {
        // Not awaited: the refusal doesn't wait on, or fail with, the stream.
        reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(read.value, { stream: true });
    }
  } catch {
    // The client broke the body off.
    return null;
  }
  return new URLSearchParams(text + decoder.decode());
}

/**
 * `POST /login`: emails a sign-in link. Our route makes the checks `auth.api`
 * calls skip (ARCHITECTURE, Auth): the origin, before the body is read; then
 * Turnstile; then `next`, reduced to a same-site path.
 */
export async function requestSignIn(c: LoginContext) {
  if (!isSameOrigin(c.req.raw.headers)) return c.html(forbiddenPage(), 403);
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  // Before the body is read or Turnstile is asked, so a flood costs neither.
  if (await isLimited(c.env.LOGIN_IP_LIMIT, await ipKey("login", clientIp))) {
    return tooManyRequests(LOGIN_WINDOW_SECONDS);
  }

  const form = await readForm(c.req.raw);
  if (form === null) {
    // Nothing of it is shown back: the form comes again empty.
    const error = "That request was too large. Please try again.";
    return c.html(
      signInPage(c.get("nonce"), { siteKey: c.env.TURNSTILE_SITE_KEY, next: "/", error }),
      413,
      NO_STORE,
    );
  }
  const email = form.get("email") ?? "";
  const next = safeNext(form.get("next"));
  // What was typed comes back in the form, unless it's too long to be an address.
  const typed = email.length > MAX_EMAIL ? "" : email;
  const formAgain = (status: 400 | 503, error: string) =>
    c.html(
      signInPage(c.get("nonce"), {
        siteKey: c.env.TURNSTILE_SITE_KEY,
        next,
        email: typed,
        error,
      }),
      status,
      NO_STORE,
    );

  const turnstile = await verifyTurnstile(form.get("cf-turnstile-response"), {
    secret: c.env.TURNSTILE_SECRET_KEY,
    hostname: new URL(c.req.url).hostname,
    action: TURNSTILE_ACTIONS.login,
    remoteIp: clientIp,
  });
  if (turnstile === "failed") {
    return formAgain(400, "The anti-spam check did not pass. Please try again.");
  }
  if (turnstile === "unavailable") {
    return formAgain(
      503,
      "The anti-spam check is not answering just now. Please try again in a minute.",
    );
  }

  // The mailer sends to no address longer than this, so no token is made for one.
  // Nor for none, which would otherwise share one limit with every other empty form.
  if (email.length > MAX_EMAIL || email.trim() === "") {
    return formAgain(400, "Enter a valid email address.");
  }
  // After Turnstile, so only a solved check can spend an address's limit.
  if (await isLimited(c.env.LOGIN_EMAIL_LIMIT, await emailKey("login", email))) {
    return tooManyRequests(LOGIN_WINDOW_SECONDS);
  }

  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    await makeAuth(c.env, db).api.signInMagicLink({
      // `next` reaches the link through metadata (auth.ts); Better Auth's own
      // callbackURL is for its verify endpoint, which isn't mounted.
      body: { email, metadata: { next } },
      headers: c.req.raw.headers,
    });
  } catch (error) {
    // Better Auth refuses an address that isn't one with a 400. Anything else is ours.
    if (isAPIError(error) && error.statusCode === 400) {
      return formAgain(400, "Enter a valid email address.");
    }
    throw error;
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
  return c.html(checkEmailPage());
}
