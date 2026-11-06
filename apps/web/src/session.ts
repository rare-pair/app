import { createDb } from "@archive/db";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { makeAuth, SESSION_COOKIE } from "./auth";
import type { Bindings } from "./env";
import { safeNext } from "./signin";

/** A signed-in user and their session, as Better Auth reads them from the cookie. */
export type Session = ReturnType<typeof makeAuth>["$Infer"]["Session"];

export type SessionVariables = { session: Session | null };

/**
 * Reads the session cookie and sets `c.var.session`: the user and their session,
 * or null when signed out. It never redirects or refuses: a page that needs an
 * account decides what to do without one. Better Auth's default lifetime holds
 * (seven days, extended once a day of use). The lookup can write: an extension
 * updates the session row and comes back as a new cookie, passed on here, and an
 * expired session's row is deleted. The connection closes as soon as the lookup is done, so a route
 * that runs for minutes, such as an upload's PUT, doesn't hold it.
 */
export const sessionMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: SessionVariables;
}> = async (c, next) => {
  // Signed out: no cookie, so nothing to look up.
  if (getCookie(c, SESSION_COOKIE) === undefined) {
    c.set("session", null);
    return next();
  }
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  const { headers, response } = await makeAuth(c.env, db)
    .api.getSession({ headers: c.req.raw.headers, returnHeaders: true })
    .finally(() => c.executionCtx.waitUntil(db.destroy()));
  c.set("session", response);
  await next();
  // After the handler, as HSTS is: a handler's own Response doesn't keep headers
  // set before it. A route that set a cookie itself, such as a sign-out, has the last
  // word on it: a refresh, or the lookup's own clearing of a dead session, after it
  // would undo it or repeat it.
  const nameOf = (cookie: string) => cookie.slice(0, cookie.indexOf("="));
  const own = new Set(c.res.headers.getSetCookie().map(nameOf));
  for (const cookie of headers.getSetCookie()) {
    if (own.has(nameOf(cookie))) continue;
    c.header("Set-Cookie", cookie, { append: true });
  }
};

/**
 * Sends the request to `target` before its page, carrying the page's path and query
 * as `next`, reduced to a same-site path: a GET or HEAD with a 302, any other method
 * with a 303, since a form post is answered with a GET. `carryPosted: false` leaves
 * `next` off the 303.
 */
export function redirectCarryingNext(c: Context, target: string, { carryPosted = true } = {}) {
  const isRead = c.req.method === "GET" || c.req.method === "HEAD";
  if (!isRead && !carryPosted) return c.redirect(target, 303);
  const url = new URL(c.req.url);
  const query = new URLSearchParams({ next: safeNext(url.pathname + url.search) });
  return c.redirect(`${target}?${query.toString()}`, isRead ? 302 : 303);
}

/**
 * For a route that needs an account, after `sessionMiddleware`: signed out, it is
 * sent to sign in, carrying the page as `next`, a POST included (ARCHITECTURE,
 * Auth, "Signed-out requests to signed-in pages"). A route that must answer a
 * script with 401 instead checks `c.var.session` itself.
 */
export const requireSignIn: MiddlewareHandler<{ Variables: SessionVariables }> = async (c, next) =>
  c.var.session != null ? next() : redirectCarryingNext(c, "/login");
