// The one-time terms page (ARCHITECTURE, Auth): a signed-in account that hasn't
// accepted the terms is sent to /welcome/terms from every page but a few, and
// accepting there continues to the page it asked for.

import { createDb } from "@archive/db";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "./env";
import { readForm } from "./login";
import { forbiddenPage, welcomeTermsPage } from "./pages";
import { redirectCarryingNext, type SessionVariables } from "./session";
import { isSameOrigin, safeNext, SITE } from "./signin";

/** The terms page itself. */
export const WELCOME_TERMS = "/welcome/terms";

/**
 * What an account that hasn't accepted the terms can still reach: the terms page,
 * the terms and privacy pages (ARCHITECTURE, Auth); the about page and removal
 * requests, which anyone can make; sign-in, so it can switch address; /admin, whose
 * own gate answers every non-moderator with the same 404 (ARCHITECTURE, Moderation),
 * so a moderator who hasn't accepted the terms still reaches it; and static files.
 * A path ending in `/*` covers itself and everything below it, by whole segment, as
 * Hono's `/assets/*` does. Sign-out belongs here once a ticket builds it.
 */
export const TERMS_EXEMPT = [
  WELCOME_TERMS,
  "/terms",
  "/privacy",
  "/about",
  "/remove/*",
  "/login",
  "/login/confirm",
  "/admin/*",
  "/assets/*",
] as const;

/**
 * The endpoints a page's script calls, whatever the method, which answer JSON: the
 * upload handshake and the polling and completion below it. A script can't follow a
 * redirect, so these get a 401 instead (ARCHITECTURE, Surge controls, Status codes).
 */
const SCRIPT_ENDPOINTS = ["/uploads/*"] as const;

// The reading position script's save, which has an id in its path, so no glob above names it.
const POSITION_SAVE = /^\/works\/[^/]+\/position$/;

/** Whether `path` is one of `paths`, written as `TERMS_EXEMPT` is. */
const isIn = (paths: readonly string[], path: string) =>
  paths.some((entry) =>
    entry.endsWith("/*")
      ? path === entry.slice(0, -2) || path.startsWith(entry.slice(0, -1))
      : path === entry,
  );

/** Whether `path` is open to an account that hasn't accepted the terms. */
export const isTermsExempt = (path: string) => isIn(TERMS_EXEMPT, path);

/**
 * Sends a signed-in account whose `terms_accepted_at` is empty to the terms page,
 * whatever the method, as `redirectCarryingNext` does, or refuses a script's
 * request with a JSON 401 `{ error }`. Runs after the session middleware;
 * signed-out visitors and accepted accounts pass untouched.
 */
export const termsGate: MiddlewareHandler<{ Variables: SessionVariables }> = async (c, next) => {
  const user = c.var.session?.user;
  if (user === undefined || user.termsAcceptedAt != null || isTermsExempt(c.req.path)) {
    return next();
  }
  // Signed in: never cached shared (#108).
  c.header("Cache-Control", "no-store");
  if (isIn(SCRIPT_ENDPOINTS, c.req.path) || POSITION_SAVE.test(c.req.path)) {
    return c.json({ error: "Accept the terms first, at /welcome/terms." }, 401);
  }
  // A form post isn't a page to come back to after accepting.
  return redirectCarryingNext(c, WELCOME_TERMS, { carryPosted: false });
};

type TermsContext = Context<{ Bindings: Bindings; Variables: SessionVariables }>;

/**
 * Where accepting continues to: `next` reduced to a same-site path, and never the
 * terms page again. A `next` that is the terms page, as signing in from it gives,
 * continues to its own `next` instead, one level deep; anything deeper goes home.
 */
function continueTo(next: string | null, depth = 0): string {
  const url = new URL(safeNext(next), SITE);
  if (url.pathname !== WELCOME_TERMS) return url.pathname + url.search;
  return depth === 0 ? continueTo(url.searchParams.get("next"), 1) : "/";
}

/**
 * `GET /welcome/terms`, after `requireSignIn`: the page to accept the terms, or, once
 * they are accepted, straight on to `next`, so a bookmark never shows it again.
 */
export function showTerms(c: TermsContext) {
  const next = continueTo(c.req.query("next") ?? null);
  c.header("Cache-Control", "no-store");
  if (c.var.session?.user.termsAcceptedAt != null) return c.redirect(next, 302);
  return c.html(welcomeTermsPage(next));
}

/**
 * `POST /welcome/terms`: sets `terms_accepted_at`, once, and continues to `next`
 * with a 303. As on the sign-in forms, the route checks the origin first, before
 * the body is read and anything is written (the global session lookup has run by
 * then), and `next` is reduced whatever the form says. Signed out, it is sent to
 * sign in, as `requireSignIn` does.
 */
export async function acceptTerms(c: TermsContext) {
  if (!isSameOrigin(c.req.raw.headers)) return c.html(forbiddenPage(), 403);
  const user = c.var.session?.user;
  if (user === undefined) return redirectCarryingNext(c, "/login");
  // A body too large to be our form is not read; accepting needs nothing from it.
  const next = (await readForm(c.req.raw))?.get("next") ?? null;
  if (user.termsAcceptedAt == null) {
    // One query, so one connection.
    const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
    try {
      // Only while still empty: accepting again keeps the first time.
      await db
        .updateTable("user")
        .set({ terms_accepted_at: new Date() })
        .where("id", "=", user.id)
        .where("terms_accepted_at", "is", null)
        .execute();
    } finally {
      c.executionCtx.waitUntil(db.destroy());
    }
  }
  c.header("Cache-Control", "no-store");
  return c.redirect(continueTo(next), 303);
}
