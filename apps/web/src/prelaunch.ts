import type { MiddlewareHandler } from "hono";
import type { Bindings } from "./env";

/**
 * Whether the archive is still closed (ARCHITECTURE, Wait list). Only "off" opens it,
 * so a missing or misspelt setting fails closed.
 */
export const isPrelaunch = (env: Pick<Bindings, "PRELAUNCH">) => env.PRELAUNCH !== "off";

// The pages open before launch (ARCHITECTURE, Wait list): the coming-soon page, the
// static pages and what they load. Sign-in is closed, so nobody gets a session until the
// archive opens. Sign-out and the terms page stay, for a session from before that: without
// the terms page, the terms gate and this redirect would send it round in a loop.
const OPEN_PATHS = new Set([
  "/",
  "/terms",
  "/privacy",
  "/about",
  "/logout",
  "/welcome/terms",
  "/robots.txt",
  "/favicon.ico",
]);
// Open with everything below them, by whole segment: /admin/launch, never /administrator.
// Not /api/auth: nothing serves it yet, and opening it before launch would be a way
// around POST /login's checks. The ticket that mounts Better Auth's handler opens only
// the routes it must, never the whole section. Sign-out is our own /logout.
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

/** Links to pages that are closed before launch: the footer's two forms, the header's four. */
const CLOSED_LINKS = [
  'footer a[href="/remove"]',
  'footer a[href="/dmca"]',
  'body > header a[href="/search"]',
  'body > header a[href="/upload"]',
  'body > header a[href="/me/uploads"]',
  'body > header a[href="/login"]',
].join(", ");

/**
 * Before launch, shows what points at a closed page as disabled: the footer's two form
 * links and the site header's "Search", "Add work", "My uploads" and "Sign in" lose their hrefs (so each goes
 * nowhere and is skipped by Tab) and say they are disabled, and the not-found page's
 * search form keeps its label with its input and button disabled. An offer to sign in within
 * a page's text (`data-sign-in-offer`) goes altogether: a dead link in a sentence reads as
 * a broken one. Applied to every HTML
 * response, so an /admin refusal still equals a real 404. After launch it does nothing.
 */
export const disableClosedLinks: MiddlewareHandler<{
  Bindings: Pick<Bindings, "PRELAUNCH">;
}> = async (c, next) => {
  await next();
  if (!isPrelaunch(c.env)) return;
  if (!c.res.headers.get("content-type")?.toLowerCase().startsWith("text/html")) return;
  c.res = new HTMLRewriter()
    .on(CLOSED_LINKS, {
      element(a) {
        a.removeAttribute("href");
        a.setAttribute("role", "link");
        a.setAttribute("aria-disabled", "true");
      },
    })
    .on("[data-sign-in-offer]", {
      element(offer) {
        offer.remove();
      },
    })
    .on('form[role="search"] input[type="search"], form[role="search"] button', {
      element(control) {
        control.setAttribute("disabled", "");
      },
    })
    .transform(c.res);
};
