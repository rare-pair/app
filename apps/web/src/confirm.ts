import { createDb } from "@archive/db";
import type { Context } from "hono";
import { makeAuth, SESSION_COOKIE } from "./auth";
import type { Bindings } from "./env";
import { INVALID_TOKEN, readForm } from "./login";
import { confirmPage, forbiddenPage, signInFailedPage } from "./pages";
import type { SecurityVariables } from "./security";
import { isSameOrigin, safeNext } from "./signin";
import { holdsSignInMarker } from "./signin-marker";

// Better Auth's tokens are 32 characters. Anything far longer was never issued, and
// isn't put back into the page.
const MAX_LINK_TOKEN = 256;

type ConfirmContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

/**
 * `GET /login/confirm`: the emailed link. It shows a button and uses nothing up
 * (ARCHITECTURE, Auth); for the browser that asked for a link, the page presses the
 * button itself. The link's query is anyone's to write, so `next` is reduced again here.
 */
export function showConfirm(c: ConfirmContext) {
  const token = c.req.query("token") ?? "";
  if (token === "" || token.length > MAX_LINK_TOKEN) return c.redirect(REFUSED, 302);
  const submitNonce = holdsSignInMarker(c) ? c.get("nonce") : undefined;
  return c.html(confirmPage(token, safeNext(c.req.query("next") ?? null), submitNonce), 200, {
    // The token is in the URL: keep it out of caches, and let a Referer carry only
    // the origin. Not no-referrer: under it the browser sends the page's own POST with
    // `Origin: null` (Fetch, "append a request Origin header"), which isSameOrigin refuses.
    "Cache-Control": "no-store",
    "Referrer-Policy": "strict-origin",
  });
}

/**
 * `POST /login/confirm`: spends the token and signs in. As on `POST /login`, our
 * route makes two of the checks `auth.api` calls skip: the origin, before the body
 * is read, and `next`, reduced to a same-site path whatever the form says. It has
 * no rate limit of its own yet (#242).
 */
export async function confirmSignIn(c: ConfirmContext) {
  if (!isSameOrigin(c.req.raw.headers)) return c.html(forbiddenPage(), 403);

  // A body too large to be our form has no token either.
  const form = (await readForm(c.req.raw)) ?? new URLSearchParams();
  const token = form.get("token") ?? "";
  if (token === "") return c.redirect(REFUSED, 303);

  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    const verified = await makeAuth(c.env, db).api.magicLinkVerify({
      query: {
        token,
        callbackURL: safeNext(form.get("next")),
        errorCallbackURL: "/login",
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const answer = answerVerified(verified);
    if (answer !== null) return answer;
    // Better Auth's own logger is off (auth.ts), so say what kind of fault it was:
    // its status and error code, never the address, the token or the link.
    const code = URL.parse(verified.headers.get("location") ?? "")?.searchParams.get("error");
    console.error(
      `POST /login/confirm: sign-in failed, ${verified.status} ${code?.replace(/[^\w-]/g, "").slice(0, 64) ?? ""}`,
    );
    return c.html(signInFailedPage(), 500);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}

/** Where a used, expired or unknown link is sent: `showSignIn` says why. `next` is dropped. */
export const REFUSED = `/login?error=${INVALID_TOKEN}`;

/**
 * Our answer to Better Auth's verify response. Signed in: its redirect, with its
 * cookie, as a 303, since a POST is answered with a GET. A used, expired or
 * unknown link: a 303 to `REFUSED`, never Better Auth's own error redirect. Null
 * for anything else, such as failing to create the user or the session: a fault
 * of ours, not the link's.
 */
export function answerVerified(verified: Response): Response | null {
  if (verified.status !== 302) return null;
  if (verified.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))) {
    return new Response(null, { status: 303, headers: verified.headers });
  }
  const location = URL.parse(verified.headers.get("location") ?? "");
  if (location?.searchParams.get("error") !== INVALID_TOKEN) return null;
  return new Response(null, { status: 303, headers: { Location: REFUSED } });
}
