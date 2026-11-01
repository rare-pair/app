import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./env";

/**
 * Whether the archive is still closed (ARCHITECTURE, Wait list). Only "off" opens it,
 * so a missing or misspelt setting fails closed.
 */
export const isPrelaunch = (env: Pick<Bindings, "PRELAUNCH">) => env.PRELAUNCH !== "off";

// The pages open before launch (ARCHITECTURE, Wait list): the coming-soon page, the
// static pages, sign-in, so an admin can sign in for the first time, and what those
// pages load. Sign-out isn't here: no doc fixes its URL yet.
const OPEN_PATHS = new Set([
  "/",
  "/terms",
  "/privacy",
  "/about",
  "/login",
  "/login/confirm",
  "/welcome/terms",
  "/robots.txt",
  "/favicon.ico",
]);
// Open with everything below them, by whole segment: /admin/launch, never /administrator.
// Not /api/auth: nothing serves it yet, and opening it before launch would be a way
// around POST /login's checks. The ticket that mounts Better Auth's handler opens only
// the routes it must (sign-out at most), never the whole section.
const OPEN_SECTIONS = ["/waitlist", "/admin", "/assets"];

const isOpenBeforeLaunch = (path: string) =>
  OPEN_PATHS.has(path) ||
  OPEN_SECTIONS.some((section) => path === section || path.startsWith(`${section}/`));

/**
 * Before launch, sends every other app page to the coming-soon page with a 302,
 * whatever the method. Runs after the www redirect, inside HSTS.
 */
export const closedBeforeLaunch: MiddlewareHandler<{
  Bindings: Pick<Bindings, "PRELAUNCH">;
}> = async (c, next) => {
  if (!isPrelaunch(c.env) || isOpenBeforeLaunch(c.req.path)) return next();
  return c.redirect("/", 302);
};

/**
 * Before launch, shows what points at a closed page as disabled: the footer's "Remove
 * my work" link loses its href (so it goes nowhere and is skipped by Tab) and says it
 * is disabled, and the not-found page's search form keeps its label with its input and
 * button disabled. Applied to every HTML response, so an /admin refusal still equals a
 * real 404. After launch it does nothing.
 */
export const disableClosedLinks: MiddlewareHandler<{
  Bindings: Pick<Bindings, "PRELAUNCH">;
}> = async (c, next) => {
  await next();
  if (!isPrelaunch(c.env)) return;
  if (!c.res.headers.get("content-type")?.toLowerCase().startsWith("text/html")) return;
  c.res = new HTMLRewriter()
    .on('footer a[href="/remove"], footer a[href="/dmca"]', {
      element(a) {
        a.removeAttribute("href");
        a.setAttribute("role", "link");
        a.setAttribute("aria-disabled", "true");
      },
    })
    .on('form[role="search"] input[type="search"], form[role="search"] button', {
      element(control) {
        control.setAttribute("disabled", "");
      },
    })
    .transform(c.res);
};
