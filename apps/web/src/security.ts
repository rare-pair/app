import type { MiddlewareHandler } from "hono";
import { CONTENT_HOST } from "./content-host";
import type { Bindings } from "./env";
import { isPrelaunch } from "./prelaunch";

export type SecurityVariables = { nonce: string };

// ARCHITECTURE, Reading: the strict policy every app page sends.
const strictPolicy = (nonce: string) =>
  [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    `img-src 'self' https://${CONTENT_HOST}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

// The pages with a Turnstile check, matched exactly: only they, and / and /waitlist
// before launch (hasTurnstile), may frame the challenge.
const TURNSTILE_PATHS = new Set(["/login", "/upload", "/remove"]);
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const TURNSTILE_FRAME = `frame-src ${TURNSTILE_ORIGIN}`;

/**
 * Sets HSTS on every response that comes back through the app, error pages and
 * redirects included, so it must run outermost (ARCHITECTURE, Hosts).
 */
export const strictTransportSecurity: MiddlewareHandler = async (c, next) => {
  await next();
  // c.header, not c.res.headers.set: it copies a response whose headers are immutable.
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
};

// www and the trailing-dot spellings of both hosts, which a browser treats as separate origins.
const REDIRECTED_HOSTS = new Set(["www.rarepair.fans", "www.rarepair.fans.", "rarepair.fans."]);

/**
 * Answers every request on those hosts, whatever the method, with a 308 to the same
 * path and query on the bare domain, before any route runs. A 308 keeps a POST a POST.
 */
export const wwwToBareDomain: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  if (!REDIRECTED_HOSTS.has(url.hostname)) return next();
  // Slice the href rather than join pathname and search, which drop a bare "?".
  const pathAndQuery = url.href.slice(url.origin.length);
  return c.body(null, 308, { Location: `https://rarepair.fans${pathAndQuery}` });
};

/** A fresh base64 nonce of 16 random bytes. */
const newNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

/**
 * Whether a path's page has a Turnstile check. The wait list form is at / only before
 * launch, and a refused `POST /waitlist` shows it again at /waitlist.
 */
const hasTurnstile = (path: string, env: Pick<Bindings, "PRELAUNCH">) =>
  TURNSTILE_PATHS.has(path) || ((path === "/" || path === "/waitlist") && isPrelaunch(env));

/**
 * Sets the CSP on every HTML response, with a nonce handlers read as c.get("nonce").
 * The Turnstile pages get the challenge frame too, keyed on path so any method has it.
 */
export const contentSecurityPolicy: MiddlewareHandler<{
  Bindings: Pick<Bindings, "PRELAUNCH">;
  Variables: SecurityVariables;
}> = async (c, next) => {
  const nonce = newNonce();
  c.set("nonce", nonce);
  await next();
  if (c.res.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
    const policy = strictPolicy(nonce);
    c.header(
      "Content-Security-Policy",
      hasTurnstile(c.req.path, c.env) ? `${policy}; ${TURNSTILE_FRAME}` : policy,
    );
    // The nonce is fresh for this response, so a shared cache that kept the page would
    // hand it to every visitor and it would protect nothing. A page that chose its own
    // Cache-Control (the tag listing's short private one) keeps it.
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store");
  }
};
