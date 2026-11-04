import { createDb } from "@archive/db";
import type { Context, MiddlewareHandler } from "hono";
import { makeAuth } from "./auth";
import type { Bindings } from "./env";
import { forbiddenPage, logoutPage, notSignedInPage } from "./pages";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { isSameOrigin } from "./signin";

type LogoutContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * `POST /logout`'s origin check, before the session middleware, so a cross-site post
 * is refused without a lookup and leaves the session as it was. Its page doesn't send
 * the person to sign in.
 */
export const sameOriginLogout: MiddlewareHandler = async (c, next) => {
  if (!isSameOrigin(c.req.raw.headers)) {
    return c.html(forbiddenPage({ signInLink: false }), 403, NO_STORE);
  }
  await next();
};

/**
 * `GET /logout`: signs nobody out, so a link prefetch or another site can't. Signed
 * in, it shows the button that posts; signed out, it says so. No script.
 */
export function showLogout(c: LogoutContext) {
  return c.html(c.var.session === null ? notSignedInPage() : logoutPage(), 200, NO_STORE);
}

/**
 * `POST /logout`, behind `sameOriginLogout`: deletes the session row and clears the
 * cookies, then answers 303 to the home page. With no session, or one already gone,
 * the answer is the same, so it says nothing of whether there was one.
 *
 * `Clear-Site-Data: "cache"` empties the browser's cached pages for the site, so a page
 * seen signed in can't come back with the signed-in header. Not `"cookies"`: the
 * reader's settings live in cookies and outlast a sign-out.
 *
 * The cookies are the ones Better Auth returns, with the attributes it set them with
 * (the `__Secure-` name needs `Secure` to be removed). It clears them even when
 * deleting the row failed, and tells us nothing of it.
 */
export async function signOutRoute(c: LogoutContext) {
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    const { headers: cleared } = await makeAuth(c.env, db).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    // Built here: a handler's own Response doesn't keep headers set before it
    // (session.ts), and the session middleware leaves a session cookie set here alone.
    const headers = new Headers({
      Location: "/",
      "Cache-Control": "no-store",
      "Clear-Site-Data": '"cache"',
    });
    for (const cookie of cleared.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
