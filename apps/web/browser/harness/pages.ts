import type { Inventory } from "./seed";

/**
 * Who visits a page: signed out, a signed-in reader (who has uploads), a moderator, or a new
 * account that hasn't accepted the terms.
 */
export type Visitor = "anonymous" | "reader" | "moderator" | "new account";

/** A page of spec 21's page inventory, as a browser reaches it. */
export type InventoryPage = {
  /** The inventory's name for it, which a failing test names. */
  name: string;
  /** Its URL path, from the ids `seedInventory` returned. */
  path: (seeded: Inventory) => string;
  as: Visitor;
  /** The status it answers with. Default 200. */
  status?: number;
  /**
   * The client is over the search limit: the page is the too-many-requests answer. A suite
   * fills the limit for the visitor's address just before it visits.
   */
  overSearchLimit?: true;
};

// A token in the shape the Worker issues. The confirm pages show their button for any such
// token on GET and spend nothing: only the POST looks it up.
const TOKEN = "q1b-token-".padEnd(43, "x");

/**
 * Every page in spec 21's page inventory (specs/scenarios/mvp/21-accessibility-and-no-js.md,
 * Setup), with the archive open.
 */
export const OPEN_PAGES: InventoryPage[] = [
  { name: "home", path: () => "/", as: "anonymous" },
  { name: "search", path: () => "/search", as: "anonymous" },
  { name: "search results", path: () => "/search?q=q1b", as: "anonymous" },
  { name: "tag listing", path: (s) => s.fandomPath, as: "anonymous" },
  { name: "work", path: (s) => `/works/${s.work}`, as: "anonymous" },
  { name: "work with many tags", path: (s) => `/works/${s.manyTags}`, as: "anonymous" },
  { name: "work with a long title", path: (s) => `/works/${s.longTitle}`, as: "anonymous" },
  { name: "warnings", path: (s) => `/works/${s.warned}/warnings`, as: "anonymous" },
  { name: "chapter", path: (s) => `/works/${s.work}/chapters/2`, as: "anonymous" },
  { name: "entire work", path: (s) => `/works/${s.work}/full`, as: "anonymous" },
  { name: "reader settings", path: () => "/settings/reader", as: "anonymous" },
  { name: "reader settings, signed in", path: () => "/settings/reader", as: "reader" },
  { name: "sign in", path: () => "/login", as: "anonymous" },
  { name: "sign-in link refused", path: () => "/login?error=INVALID_TOKEN", as: "anonymous" },
  { name: "confirm sign-in", path: () => `/login/confirm?token=${TOKEN}`, as: "anonymous" },
  { name: "accept terms", path: () => "/welcome/terms", as: "new account" },
  { name: "upload", path: () => "/upload", as: "reader" },
  { name: "my uploads", path: () => "/me/uploads", as: "reader" },
  { name: "remove", path: () => "/remove", as: "anonymous" },
  { name: "confirm removal", path: () => `/remove/confirm?token=${TOKEN}`, as: "anonymous" },
  { name: "report", path: (s) => `/works/${s.work}/report`, as: "reader" },
  { name: "DMCA", path: () => "/dmca", as: "anonymous" },
  { name: "admin", path: () => "/admin", as: "moderator" },
  { name: "admin reports", path: () => "/admin/reports", as: "moderator" },
  { name: "admin report", path: (s) => `/admin/reports/${s.report}`, as: "moderator" },
  { name: "admin takedowns", path: () => "/admin/takedowns", as: "moderator" },
  { name: "admin takedown", path: (s) => `/admin/takedowns/${s.takedown}`, as: "moderator" },
  { name: "admin requests", path: () => "/admin/requests", as: "moderator" },
  { name: "admin request", path: (s) => `/admin/requests/${s.request}`, as: "moderator" },
  { name: "admin works to check", path: () => "/admin/works", as: "moderator" },
  { name: "work admin", path: (s) => `/admin/works/${s.toCheck}`, as: "moderator" },
  { name: "about", path: () => "/about", as: "anonymous" },
  { name: "terms", path: () => "/terms", as: "anonymous" },
  { name: "privacy", path: () => "/privacy", as: "anonymous" },
  { name: "hidden", path: (s) => `/works/${s.hidden}`, as: "anonymous", status: 451 },
  { name: "removed", path: (s) => `/works/${s.removed}`, as: "anonymous", status: 410 },
  {
    name: "too many requests",
    path: () => "/search?q=q1b",
    as: "anonymous",
    status: 429,
    overSearchLimit: true,
  },
  { name: "not found", path: () => "/q1b-no-such-page", as: "anonymous", status: 404 },
];

/**
 * The pages before launch (PRELAUNCH on): the coming-soon page and the wait list's links,
 * which spec 21 doesn't list, and pages that stay open, whose footers show closed links
 * disabled.
 */
export const PRELAUNCH_PAGES: InventoryPage[] = [
  { name: "coming soon", path: () => "/", as: "anonymous" },
  { name: "wait list confirm", path: () => `/waitlist/confirm?token=${TOKEN}`, as: "anonymous" },
  {
    name: "wait list unsubscribe",
    path: () => `/waitlist/unsubscribe?token=${TOKEN}`,
    as: "anonymous",
  },
  { name: "sign in, before launch", path: () => "/login", as: "anonymous" },
  { name: "about, before launch", path: () => "/about", as: "anonymous" },
];
