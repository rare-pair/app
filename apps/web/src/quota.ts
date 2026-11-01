import type { Context } from "hono";

// The daily upload quota's pure parts (ARCHITECTURE, Surge controls). The count is kept in
// Postgres (`useUploadQuota` in @archive/db); the day is the UTC calendar day.

/** Used when `UPLOAD_QUOTA_NEW` is missing or misspelt: a bad var never turns the quota off. */
export const DEFAULT_NEW_LIMIT = 20;
/** Used when `UPLOAD_QUOTA_TRUSTED` is missing or misspelt. */
export const DEFAULT_TRUSTED_LIMIT = 100;

/** The most a limit can be set to: a typo of extra digits is no limit at all. */
const MAX_LIMIT = 100_000;

// A positive whole number in plain decimal, or the default.
function limitOf(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  return n >= 1 && n <= MAX_LIMIT ? n : fallback;
}

/**
 * The most uploads an account may confirm in a UTC day. Moderators and admins are the
 * trusted tier; every other account, new or not, gets the new-account limit.
 */
export function limitFor(
  role: string | null,
  vars: { UPLOAD_QUOTA_NEW?: string; UPLOAD_QUOTA_TRUSTED?: string },
): number {
  return role === "moderator" || role === "admin"
    ? limitOf(vars.UPLOAD_QUOTA_TRUSTED, DEFAULT_TRUSTED_LIMIT)
    : limitOf(vars.UPLOAD_QUOTA_NEW, DEFAULT_NEW_LIMIT);
}

/** Whole seconds to the next midnight UTC, rounded up: the quota's reset, and `Retry-After`. */
export function secondsToReset(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The plain message of a spent quota, which says when the account can upload again. */
export function quotaSpentMessage(seconds: number): string {
  const hours = Math.ceil(seconds / 3600);
  return `You've used today's upload quota. It resets at midnight UTC, in about ${hours} ${hours === 1 ? "hour" : "hours"}, and you can upload again then.`;
}

/**
 * The 429 of a spent quota, for a script endpoint: `{ error, retryAfter }` as JSON, with
 * `Retry-After` the same whole seconds, and `no-store`.
 */
export function quotaSpent(c: Context): Response {
  const retryAfter = secondsToReset(new Date());
  return c.json({ error: quotaSpentMessage(retryAfter), retryAfter }, 429, {
    "Cache-Control": "no-store",
    "Retry-After": String(retryAfter),
  });
}
