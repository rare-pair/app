// The Workers rate-limiting binding's side of the surge controls (ARCHITECTURE, Surge
// controls), shared by every limited route: sign-in, uploads, search, removal requests, the wait
// list and reads. Each route passes its own binding and key.

import { hashKey } from "@archive/traffic";
import type { Context } from "hono";
import { tooManyRequestsPage, tooManyRequestsTodayPage } from "./pages";

export { ipKey, isLimited } from "@archive/traffic";

/** The sign-in limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const LOGIN_WINDOW_SECONDS = 60;

/** The wait list limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const WAITLIST_WINDOW_SECONDS = 60;

/** The notice form's limit window, as wrangler.jsonc sets it: the binding doesn't say. */
export const DMCA_WINDOW_SECONDS = 60;

/** The removal form's limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const REMOVE_WINDOW_SECONDS = 60;

/** The upload limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const UPLOAD_WINDOW_SECONDS = 60;

/** The search limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const SEARCH_WINDOW_SECONDS = 60;

/** The read throttles' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const READ_WINDOW_SECONDS = 60;

/** A limit's key for an email address, however it was spelt: trimmed and lowercased. */
export const emailKey = (scope: string, address: string) =>
  hashKey(`${scope}-email:`, address.trim().toLowerCase());

/**
 * A limit's key for a signed-in user, from the user's id as is: an id is not an email address,
 * so it isn't trimmed or lowercased.
 */
export const userKey = (scope: string, userId: string) => hashKey(`${scope}-user:`, userId);

/**
 * The 429 for a limited request: the plain page and `Retry-After`, both saying the same
 * whole number of seconds, rounded up and at least one.
 */
export function tooManyRequests(seconds: number): Response {
  const wait = Math.max(1, Math.ceil(seconds));
  return plainPage429(tooManyRequestsPage(wait), wait);
}

/**
 * The 429 for an address that has had the day's sign-in emails: `seconds`, to midnight UTC, are
 * too many to read, so the page names the time and only `Retry-After` counts.
 */
export const tooManyRequestsToday = (seconds: number): Response =>
  plainPage429(tooManyRequestsTodayPage(), seconds);

function plainPage429(html: string, seconds: number): Response {
  return new Response(html, {
    status: 429,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Retry-After": String(seconds),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * A 429 for a script endpoint: `{ error, retryAfter }` as JSON, `Retry-After` the same whole
 * number of seconds (rounded up, at least one), and `no-store`.
 */
export function tooManyRequestsJson(c: Context, error: string, seconds: number): Response {
  const retryAfter = Math.max(1, Math.ceil(seconds));
  return c.json({ error, retryAfter }, 429, {
    "Cache-Control": "no-store",
    "Retry-After": String(retryAfter),
  });
}
