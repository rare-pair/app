// The read throttles on the app (ARCHITECTURE, Crawlers and agents; spec 24): chapter pages and
// whole works, per client. Each is mounted on its route, which takes HEAD too, right after the
// refusals and before the session, the edge cache and the page, so a refused request spends
// nothing and a cached chapter still gets the 429. They only slow a scraper.

import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { ipKey, isLimited, READ_WINDOW_SECONDS, tooManyRequests } from "./rate-limit";

/** The 429 for a client past the limit `binding` keeps, under its own `scope` of key. */
const throttleReads =
  (
    binding: "READ_CHAPTER_LIMIT" | "READ_FULL_LIMIT",
    scope: string,
  ): MiddlewareHandler<{ Bindings: Bindings }> =>
  async (c, next) => {
    const key = await ipKey(scope, c.req.header("cf-connecting-ip") ?? null);
    if (!(await isLimited(c.env[binding], key))) return next();
    // The whole line: the reason and nothing else, since a URL or address has no place in it.
    console.log("refused: read throttle");
    return tooManyRequests(READ_WINDOW_SECONDS);
  };

export const throttleChapterReads = throttleReads("READ_CHAPTER_LIMIT", "read-chapter");
export const throttleFullReads = throttleReads("READ_FULL_LIMIT", "read-full");
