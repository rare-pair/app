// The read throttles on the app (ARCHITECTURE, Crawlers and agents; spec 24): chapter pages and
// whole works, per client. They run right after the refusals and before the session, the edge
// cache and every route, so a refused request spends nothing and a cached chapter still gets
// the 429. They only slow a scraper.

import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { ipKey, isLimited, READ_WINDOW_SECONDS, tooManyRequests } from "./rate-limit";

// `c.req.path` is the decoded form the router matches, so a percent-encoded spelling still counts.
const CHAPTER_READ = /^\/works\/[^/]+\/chapters\/[^/]+$/;
const FULL_READ = /^\/works\/[^/]+\/full$/;

/** The limit `path` spends, and the scope of its key, or null when it isn't a read. */
function limitOf(env: Bindings, path: string) {
  if (CHAPTER_READ.test(path)) return { limiter: env.READ_CHAPTER_LIMIT, scope: "read-chapter" };
  if (FULL_READ.test(path)) return { limiter: env.READ_FULL_LIMIT, scope: "read-full" };
  return null;
}

/** The 429 for a client past its limit of chapter pages or of whole works. */
export const throttleReads: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const read =
    c.req.method === "GET" || c.req.method === "HEAD" ? limitOf(c.env, c.req.path) : null;
  if (read === null) return next();
  const key = await ipKey(read.scope, c.req.header("cf-connecting-ip") ?? null);
  if (!(await isLimited(read.limiter, key))) return next();
  // The whole line: the reason and nothing else, since a URL or address has no place in it.
  console.log("refused: read throttle");
  return tooManyRequests(READ_WINDOW_SECONDS);
};
