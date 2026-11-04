// The site header's links: what a visitor can do from any page. Built per response from
// the session, never stored: the only data shared between readers is the chapter page
// entry (edge-cache.ts), which holds no layout, so no header can reach a shared cache.

import { isModeratorRole } from "@archive/db";
import type { MiddlewareHandler } from "hono";
import type { SessionVariables } from "./session";

/** What the header's links depend on. */
export type Visitor = { signedIn: boolean; moderator: boolean };

/**
 * The header's navigation, left to right: Add work, My uploads (signed in), Admin (a
 * moderator or an admin), then Sign in or Sign out. Constants only, so nothing in it is
 * escaped: no name or address is ever shown. Sign out is a form, so it works with
 * scripts off and by keyboard; /logout is where it posts.
 */
export const headerLinks = ({ signedIn, moderator }: Visitor): string => {
  const items = ['<a href="/upload">Add work</a>'];
  if (signedIn) items.push('<a href="/me/uploads">My uploads</a>');
  if (moderator) items.push('<a href="/admin">Admin</a>');
  items.push(
    signedIn
      ? '<form method="post" action="/logout"><button type="submit">Sign out</button></form>'
      : '<a href="/login">Sign in</a>',
  );
  return `\n<nav aria-label="Site">${items.join("\n")}</nav>\n`;
};

/**
 * Puts the links into the layout's own <header>, on every HTML page that comes back
 * through here. Rewrites instead of threading the viewer through every page builder:
 * the pages built before the session middleware (a cross-site refusal, a redirect)
 * keep the bare header, with the site name only. Register it after
 * `disableClosedLinks`, so that sees what this adds, and inside the CSP, which keys on
 * the content type this keeps. Sets no Cache-Control: every HTML response is
 * `private, no-store` already, bar the tag listing's own `private, max-age=60,
 * stale-while-revalidate=60` (a browser may keep its header for up to two minutes:
 * FRONTEND-DISCOVERY, *Site header*).
 * The role comes with the session lookup, so a promotion or demotion shows as late as
 * that lookup does; /admin's own gate is the authority. A static asset's 404 never
 * ran the session middleware, so it shows the signed-out header.
 */
export const siteHeader: MiddlewareHandler<{ Variables: SessionVariables }> = async (c, next) => {
  await next();
  if (!c.res.headers.get("content-type")?.toLowerCase().startsWith("text/html")) return;
  const user = c.var.session?.user;
  const links = headerLinks({
    signedIn: user != null,
    moderator: isModeratorRole(user?.role),
  });
  // `body > header` is the layout's. A sanitised chapter could carry a <header> of its own
  // in `main`, which is never a child of <body>; the first-only guard is for the same reason.
  let seen = false;
  c.res = new HTMLRewriter()
    .on("body > header", {
      element(header) {
        if (seen) return;
        seen = true;
        header.append(links, { html: true });
      },
    })
    .transform(c.res);
};
