import type { Handler, MiddlewareHandler } from "hono";

/** What every response says about indexing, archiving and use for AI (ARCHITECTURE, Signals). */
export const ROBOTS_TAG = "noindex, noarchive, noai, noimageai";

/**
 * Sets X-Robots-Tag on every response that comes back through the app, redirects
 * and error pages included, so it must run outermost. It asks; it enforces nothing.
 */
export const robotsTag: MiddlewareHandler = async (c, next) => {
  await next();
  // c.header, not c.res.headers.set: it copies a response whose headers are immutable.
  c.header("X-Robots-Tag", ROBOTS_TAG);
};

export const ROBOTS_TXT = `User-agent: *
Disallow: /
Content-Signal: search=no, ai-input=no, ai-train=no
`;

/** The same file for every client, a declared automated one included. */
export const robotsTxt: Handler = (c) =>
  c.body(ROBOTS_TXT, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
