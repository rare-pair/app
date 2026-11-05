import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { LINK_LIFETIME_MINUTES } from "./signin";

// The marker: this browser asked for a sign-in link recently, so the link's page may
// submit itself here (ARCHITECTURE, Auth). It says nothing about who asked or which
// link. `__Host-`: Secure, Path=/ and no Domain. Lax, since a link opened from webmail
// is a cross-site navigation. HttpOnly, since only the server reads it.
const MARKER = "__Host-signin-pending";
const ATTRIBUTES = "; Path=/; SameSite=Lax; Secure; HttpOnly";

/** The whole `Set-Cookie` value an accepted `POST /login` sends. It lasts as long as the link. */
export const SET_SIGN_IN_MARKER = `${MARKER}=1; Max-Age=${LINK_LIFETIME_MINUTES * 60}${ATTRIBUTES}`;

// A `__Host-` cookie is cleared only with the same attributes.
const CLEAR_SIGN_IN_MARKER = `${MARKER}=; Max-Age=0${ATTRIBUTES}`;

/** Whether this browser holds the marker. */
export const holdsSignInMarker = (c: Context) => getCookie(c, MARKER) === "1";

/**
 * For `POST /login/confirm`: every answer clears the marker, a refusal or a fault
 * included, so going back to or reloading the link's page posts nothing by itself.
 * After the answer, as the session cookie it joins comes first.
 */
export const clearSignInMarker: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Set-Cookie", CLEAR_SIGN_IN_MARKER, { append: true });
};
