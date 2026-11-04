// The server half of a Turnstile check, shared by every form that has one:
// sign-in, the wait list, upload requests and removal requests (ARCHITECTURE, Surge controls).
// It takes everything site-specific as arguments, so each route passes its own.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// Cloudflare's limit on a token's length.
const MAX_TOKEN = 2048;

/**
 * What each form's widget names with `data-action`, and its check expects back from
 * siteverify, so a token solved on one form is refused by every other. Cloudflare allows
 * up to 32 letters, digits, `_` and `-`. `remove` is for the removal form.
 */
export const TURNSTILE_ACTIONS = {
  login: "login",
  waitlist: "waitlist",
  upload: "upload",
  remove: "remove",
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

// Cloudflare's published test secrets, which always pass, always fail, or report a spent token
// (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). Their dummy flow
// doesn't promise the action the widget set, so under them the action isn't compared (the
// host still is, and their dummy reply says "localhost"): `wrangler dev` keeps working.
// A real secret always checks both.
const CLOUDFLARE_TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

/**
 * `passed` only when Cloudflare says so for this host. `unavailable` when
 * Cloudflare couldn't be asked: the caller refuses the request either way.
 */
export type TurnstileResult = "passed" | "failed" | "unavailable";

export interface TurnstileCheck {
  /** The widget's secret key. */
  secret: string;
  /** The host the request came in on. A token solved on any other host fails. */
  hostname: string;
  /** The form's action. A token its widget solved under any other action fails. */
  action: TurnstileAction;
  /** The visitor's address (`cf-connecting-ip`), when known. */
  remoteIp?: string | null;
  /** The Worker's `fetch` when left out; a test passes its own. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** How long to wait for Cloudflare before calling it unavailable. 5 seconds when left out. */
  timeoutMs?: number;
}

/** Checks the `cf-turnstile-response` value of a submitted form, null when it has none. */
export async function verifyTurnstile(
  token: string | null,
  check: TurnstileCheck,
): Promise<TurnstileResult> {
  if (token === null || token === "" || token.length > MAX_TOKEN) return "failed";
  const body = new URLSearchParams({ secret: check.secret, response: token });
  if (check.remoteIp) body.set("remoteip", check.remoteIp);

  let reply: { success?: unknown; hostname?: unknown; action?: unknown } | null;
  try {
    const res = await (check.fetch ?? fetch)(SITEVERIFY, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(check.timeoutMs ?? 5000),
    });
    if (!res.ok) return "unavailable";
    reply = await res.json();
  } catch {
    // Unreachable, too slow, or an answer that isn't JSON.
    return "unavailable";
  }
  // JSON, but not the reply object Cloudflare sends.
  if (reply === null || Array.isArray(reply) || !(reply instanceof Object)) return "unavailable";
  if (reply.success !== true || reply.hostname !== check.hostname) return "failed";
  // A reply with no action, or one that isn't a string, is no match.
  if (!CLOUDFLARE_TEST_SECRETS.has(check.secret) && reply.action !== check.action) return "failed";
  return "passed";
}
