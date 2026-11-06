import type { Context } from "hono";
import { isModerator } from "./admin";
import { tooManyRequestsJson } from "./rate-limit";

// The daily upload quota's pure parts, and the daily limit on sign-in emails (ARCHITECTURE,
// Surge controls). The counts are kept in Postgres (`useUploadQuota` and `countSignInEmail` in
// @archive/db); the day is the UTC calendar day.

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
  const lower = limitOf(vars.UPLOAD_QUOTA_NEW, DEFAULT_NEW_LIMIT);
  // Never below the new-account limit: setting only that one can't leave the trusted tier worse.
  return isModerator(role)
    ? Math.max(lower, limitOf(vars.UPLOAD_QUOTA_TRUSTED, DEFAULT_TRUSTED_LIMIT))
    : lower;
}

/**
 * The most sign-in emails one address may be sent in a UTC day (`countSignInEmail` in
 * @archive/db). A missing or misspelt `LOGIN_EMAIL_QUOTA` gives 5: a bad var never turns it off.
 */
export function signInEmailLimit(vars: { LOGIN_EMAIL_QUOTA?: string }): number {
  return limitOf(vars.LOGIN_EMAIL_QUOTA, 5);
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
  return tooManyRequestsJson(c, quotaSpentMessage(retryAfter), retryAfter);
}

/** How long to wait before asking again past the cap on open uploads: the reaper is daily, so no moment is exact. */
const OPEN_RETRY_SECONDS = 3600;

/**
 * The 429 of asking past the cap on open uploads: links asked for and never confirmed, which the
 * sweep's daily reaper clears. "About a day" is apps/sweep's UNCONFIRMED_UPLOAD_DAYS, which this
 * Worker can't read.
 */
export function tooManyOpen(c: Context, left: number): Response {
  const room =
    left === 0
      ? "You have too many unfinished uploads to start another."
      : `You have too many unfinished uploads to start all of these. You can start ${left} more now.`;
  return tooManyRequestsJson(
    c,
    `${room} Unfinished uploads clear by themselves after about a day, so please try again then.`,
    OPEN_RETRY_SECONDS,
  );
}

/**
 * The 429 of a batch bigger than the quota left: how many uploads remain today, and when
 * the quota resets, as `quotaSpent` says it.
 */
export function quotaShort(c: Context, left: number): Response {
  const retryAfter = secondsToReset(new Date());
  const noun = left === 1 ? "upload" : "uploads";
  return tooManyRequestsJson(
    c,
    `You have ${left} ${noun} left today, and you picked more. Pick ${left} or fewer, or wait until midnight UTC for the quota to reset.`,
    retryAfter,
  );
}
