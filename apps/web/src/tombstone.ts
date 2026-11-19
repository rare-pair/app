import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { escapeHtml } from "./pages";
import { LOGO_PATH, LOGO_SVG } from "./logo";
import { ROBOTS_TXT } from "./robots";
import { STYLESHEET, STYLESHEET_PATH } from "./styles";

/**
 * Whether the archive is closed for good. Only "off" keeps it open, so a missing or misspelt
 * setting fails closed, as PRELAUNCH does.
 */
export const isTombstoned = (env: Pick<Bindings, "TOMBSTONE">) => env.TOMBSTONE !== "off";

/** The tombstone page. Its own document: the layout's header and footer link to closed pages. */
export const tombstonePage = (contact: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>rarepair has closed</title><link rel="stylesheet" href="${STYLESHEET_PATH}"><link rel="icon" type="image/svg+xml" href="${LOGO_PATH}"></head>
<body>
<main id="main">
<h1>rarepair has closed</h1>
<p>rarepair was a temporary stopgap, and it has shut down. Its works, uploads and accounts are no longer available here.</p>
<p>Thank you to everyone who read, uploaded and helped.</p>
<p>Questions: <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a></p>
</main>
</body>
</html>`;

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * When tombstoned, answers every request with the 410 page, whatever the method or path, before
 * the session, the database or any route. robots.txt, and the stylesheet and tab icon the page
 * loads, are served here from memory. Runs inside HSTS, the www redirect and the CSP.
 */
export const tombstone: MiddlewareHandler<{
  Bindings: Pick<Bindings, "TOMBSTONE" | "NOTICES_EMAIL">;
}> = async (c, next) => {
  if (!isTombstoned(c.env)) return next();
  const isRead = c.req.method === "GET" || c.req.method === "HEAD";
  if (isRead && c.req.path === "/robots.txt") {
    return c.body(ROBOTS_TXT, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  }
  if (isRead && c.req.path === STYLESHEET_PATH) {
    return c.body(STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
    });
  }
  if (isRead && c.req.path === LOGO_PATH) {
    return c.body(LOGO_SVG, 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
    });
  }
  c.header("Cache-Control", "no-store");
  return c.html(tombstonePage(c.env.NOTICES_EMAIL), 410);
};
