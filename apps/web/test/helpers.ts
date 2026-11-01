import { env, exports } from "cloudflare:workers";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { parseMessage, type EmailMessage } from "../../mailer/src/message";

// Shared by the workerd tests. (11-reader-and-csp and 20-site-chrome keep their own
// copies for now.)

export const BASE = "https://rarepair.fans";
// SAFETY: the default export is the Worker under test, loaded from wrangler.jsonc's main.
const worker = (exports as any).default as Fetcher;

/** A request to the Worker under test, with redirects returned rather than followed. */
export const fetchW = (input: string, init: RequestInit = {}) =>
  worker.fetch(new URL(input, BASE).toString(), { redirect: "manual", ...init });

// The policies from ARCHITECTURE, Reading, with the nonce left as {n}.
export const STRICT =
  "default-src 'self'; script-src 'nonce-{n}' 'strict-dynamic'; style-src 'self'; img-src 'self' https://content.rarepair.fans; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const TURNSTILE = `${STRICT}; frame-src https://challenges.cloudflare.com`;

/** The nonce in a CSP header, or null when there is none. */
export const nonceOf = (csp: string | null) => csp?.match(/'nonce-([^']*)'/)?.[1] ?? null;

/** The header with its nonce swapped back to {n}, for whole-string comparison. */
export const withoutNonce = (csp: string | null) =>
  csp?.replace(/'nonce-[^']*'/, "'nonce-{n}'") ?? null;

/** Every message the `email` queue has delivered so far, from vitest.config.ts's email-sink. */
export async function deliveredEmails(): Promise<unknown[]> {
  // SAFETY: the sink answers with the JSON array of message bodies it was delivered.
  return (await (await env.EMAIL_SINK.fetch("https://email-sink/")).json()) as unknown[];
}

/**
 * Waits for the queue to deliver `atLeast` messages to `to`, and returns every one it has.
 * Fails, naming the address, if they haven't come in 10 seconds.
 */
export async function emailsTo(to: string, { atLeast = 1 } = {}): Promise<EmailMessage[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const mine = (await deliveredEmails())
      .map(parseMessage)
      .filter((email): email is EmailMessage => email?.to === to);
    if (mine.length >= atLeast) return mine;
    if (Date.now() > deadline) {
      throw new Error(`${mine.length} of ${atLeast} emails to ${to} delivered in 10 seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The tokens vitest.config.ts's siteverify stand-in passes, one for each form: the dummy
// token as solved under that form's action. The other forms refuse it.
export const LOGIN_TOKEN = "XXXX.DUMMY.TOKEN.XXXX#login";
export const WAITLIST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX#waitlist";
export const UPLOAD_TOKEN = "XXXX.DUMMY.TOKEN.XXXX#upload";
export const REMOVE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX#remove";

/** The headers a browser on rarepair.fans sends with the sign-in form. */
const LOGIN_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: BASE,
  "sec-fetch-site": "same-origin",
};

/**
 * A client address under 10.0.0.0/8, new for each sign-in request, so that only a test
 * that sets `cf-connecting-ip` itself meets the per-IP limit. Random rather than counted:
 * every test file of a project shares one limiter.
 */
export const freshIp = () => `10.${crypto.getRandomValues(new Uint8Array(3)).join(".")}`;

/** The sign-in form's POST, as a browser on rarepair.fans submits it, from a fresh IP. */
export const loginRequest = (fields: Record<string, string>) =>
  new Request(`${BASE}/login`, {
    method: "POST",
    headers: { ...LOGIN_HEADERS, "cf-connecting-ip": freshIp() },
    body: new URLSearchParams(fields).toString(),
  });

/**
 * Submits the sign-in form to the Worker from a fresh IP; `headers` are added over a
 * browser's, so a test can set its own `cf-connecting-ip`.
 */
export function postLogin(
  fields: Record<string, string>,
  {
    url = "/login",
    headers = {},
    body = new URLSearchParams(fields).toString(),
  }: { url?: string; headers?: Record<string, string>; body?: BodyInit } = {},
) {
  return fetchW(url, {
    method: "POST",
    headers: { ...LOGIN_HEADERS, "cf-connecting-ip": freshIp(), ...headers },
    body,
  });
}

/**
 * Signs `email` in through the Worker, as a browser follows the newest emailed link to
 * the confirm page and presses its button, and returns the `name=value` of its session
 * cookie. A new account hasn't accepted the terms, so every page but a few redirects it
 * to /welcome/terms: pass `acceptTerms: true` to accept them too.
 */
export async function signIn(
  email: string,
  { next = "/", acceptTerms: accept = false }: { next?: string; acceptTerms?: boolean } = {},
): Promise<string> {
  const before = (await emailsTo(email, { atLeast: 0 })).length;
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const sent = await emailsTo(email, { atLeast: before + 1 });
  const token = new URL(sent.at(-1)!.url).searchParams.get("token")!;
  const res = await postLogin({ token, next }, { url: "/login/confirm" });
  expect(res.status).toBe(303);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  if (accept) await acceptTerms(cookie);
  return cookie;
}

/** Accepts the terms with `cookie`, as /welcome/terms's form posts it, and returns the answer. */
export async function acceptTerms(cookie: string, next = "/") {
  const res = await postLogin({ next }, { url: "/welcome/terms", headers: { cookie } });
  expect(res.status).toBe(303);
  return res;
}

export {
  DMCA_IP_LIMIT,
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  REMOVE_EMAIL_LIMIT,
  REMOVE_IP_LIMIT,
} from "./limits";

/**
 * Waits, if need be, for a window of `periodSeconds` with at least 20 seconds left in it, time
 * enough to fill a limit and wait on its emails. The local limiter's windows are fixed and
 * aligned to the clock, so a test that fills one and then expects a 429 must not straddle
 * the boundary.
 */
export async function windowHeadroom(periodSeconds: number) {
  const left = periodSeconds * 1000 - (Date.now() % (periodSeconds * 1000));
  if (left < 20_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

/**
 * Captures every console line while `run` runs, as a log would show it: inspect prints an
 * error's stack, cause and own fields, at any depth. Returns the lines.
 */
export async function consoleDuring(run: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args) => {
      logged.push(args.map((arg) => inspect(arg, { depth: Infinity })).join(" "));
    }),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return logged;
}
