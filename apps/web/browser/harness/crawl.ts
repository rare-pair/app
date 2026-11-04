import type { Page } from "playwright";
import type { InventoryPage, Visitor } from "./pages";
import type { Inventory } from "./seed";
import { SITE, type Site } from "./site";
import type { Unlinked } from "./unlinked";

// A crawl of the site by its links: from the home page, as one visitor, it follows every
// same-site <a href> and every form that gets, and records the pages it reaches. A page of
// spec 21's inventory that a visitor can't reach this way, and that isn't on the unlinked list
// (unlinked.ts), is a page with no way in: a link someone forgot or removed.
//
// What it can't see. It fetches pages from Node and reads the HTML that comes back: the links
// the server wrote. So it cannot tell a link a person can't use: one hidden by CSS, covered by
// another element, taken out by a script, given no name, or out of reach of the keyboard
// (a11y/keyboard.browser.test.ts walks the Tab order). A link the page adds by script is not
// seen either, and nothing runs, so a page's script never posts. The journeys are what click;
// this only shows a link was served.
//
// What it never does. It never submits a form that posts (sign out, report, login, remove,
// the DMCA notice, terms, settings, the admin actions) and follows no link whose path ends in
// an admin action verb. The GETs it follows change nothing: /logout and the confirm pages
// only show a button, chapters and works write nothing (the reading position is a script's
// POST), and `/uploads/:id`, which polls JSON, is not linked. Spec 24's read throttles (not
// built) are 120 chapters and 10 entire works a minute for one address; a crawl reads about
// a dozen chapters and five entire works as one visitor, with an address of its own.

/** A browser's User-Agent: the crawler list of spec 24 refuses HTTP libraries on chapters. */
export const CRAWLER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/130.0.0.0 Safari/537.36";

/** What a text box of a form that gets is filled with, by form action and field name. */
const FORM_VALUES = new Map([["/search", new Map([["q", "q1b"]])]]);

/** A path whose last segment is an action of the moderators', which a crawl must not trigger. */
const ADMIN_ACTION =
  /^\/admin\/.*\/(approve|reject|hide|restore|remove|dismiss|resolve|ban|unban)$/;

/** Fetches of one route template before the rest of it is left alone. */
const PER_TEMPLATE = 40;
/** Fetches of a whole crawl; more means a new generator of links, and fails. */
const MAX_FETCHES = 300;
const MAX_REDIRECTS = 5;

type Field = { name: string; type: string; value: string; checked: boolean };
type Parsed = { links: string[]; forms: { method: string; action: string; fields: Field[] }[] };

/** Reads the HTML in `html` with the browser's own parser, on a page that shows nothing. */
function parse(page: Page, html: string): Promise<Parsed> {
  return page.evaluate((source) => {
    // DOMParser makes a document whose scripts never run and whose resources never load.
    const doc = new DOMParser().parseFromString(source, "text/html");
    const links = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    const forms = [...doc.querySelectorAll("form")].map((form) => ({
      method: (form.getAttribute("method") ?? "get").toLowerCase(),
      action: form.getAttribute("action") ?? "",
      fields: [...form.elements].flatMap((element) => {
        // SAFETY: the form's controls with a name are inputs, selects and textareas, which all
        // have the name, type and value read here; `checked` is false on all but checkboxes.
        const field = element as HTMLInputElement;
        if (!field.name) return [];
        return [{ name: field.name, type: field.type, value: field.value, checked: field.checked }];
      }),
    }));
    return { links, forms };
  }, html);
}

/** `href` from the page at `from`, as a path and query on the site, or null for anything else. */
function sameSite(href: string, from: string): string | null {
  // A link within the page (the skip link) leads nowhere new.
  if (href.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(href, new URL(from, SITE));
  } catch {
    return null;
  }
  if (url.origin !== new URL(SITE).origin) return null;
  return url.pathname + url.search;
}

/** The query a form that gets sends: the values its fields have, a text box from the table. */
function formQuery(action: string, fields: Field[], blank: boolean): URLSearchParams {
  const query = new URLSearchParams();
  const table = FORM_VALUES.get(action);
  for (const { name, type, value, checked } of fields) {
    if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !checked) continue;
    const given = table?.get(name);
    query.append(name, given === undefined ? value : blank ? "" : given);
  }
  return query;
}

/**
 * Every same-site page the HTML at `from` leads to, as a path and query: each link, and each
 * form that gets, sent with its fields' values (a text box the crawler has a value for is sent
 * with it, and again empty, as a person who submits at once sends it). Forms that post lead
 * nowhere here, nor do those that get to the page they are on. Fragments are dropped.
 */
export async function linkTargets(page: Page, html: string, from: string): Promise<string[]> {
  const { links, forms } = await parse(page, html);
  const found: (string | null)[] = links.map((href) => sameSite(href, from));
  for (const form of forms) {
    if (form.method !== "get") continue;
    const action = sameSite(form.action, from);
    if (action === null) continue;
    const path = action.split("?")[0] ?? action;
    // A form that gets back to its own page filters it (a listing's sort): no page to reach.
    if (path === from.split("?")[0]) continue;
    const tabled = FORM_VALUES.has(path);
    for (const blank of tabled ? [false, true] : [false]) {
      found.push(`${path}?${formQuery(path, form.fields, blank)}`.replace(/\?$/, ""));
    }
  }
  return found.filter((target): target is string => target !== null);
}

/**
 * The key a page is known by: its path and its query with `next` (where a page returns to,
 * which differs on every page that links it) and empty parameters dropped, in a fixed order.
 */
export function nodeKey(target: string): string {
  const url = new URL(target, SITE);
  const kept = [...url.searchParams].filter(([name, value]) => name !== "next" && value !== "");
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(kept).toString();
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}

/** The route a path is a page of: numbers are ids, and a tag's type and name are one route. */
export function templateOf(path: string): string {
  const segments = path.split("?")[0]?.split("/") ?? [];
  if (segments[1] === "tags") return "/tags/:type/:name";
  return segments.map((s) => (/^\d+$/.test(s) ? ":id" : s)).join("/");
}

/** What a crawl found. */
export type CrawlResult = {
  /** The pages reached, by `nodeKey` of the path they ended at after redirects, and status. */
  reached: Map<string, number>;
  /** The `nodeKey` of everything a link or form led to, whether or not it was fetched. */
  seen: Set<string>;
  /** Links that ended 400 or more: where from, where to, and the status. */
  dead: { from: string; to: string; status: number }[];
  /** Routes whose pages stopped being fetched at the limit per route. */
  capped: string[];
};

export type CrawlOptions = {
  /** The visitor's `cookie` header; none for a signed-out visitor. */
  cookie?: string;
  /** The address the Worker sees, for its rate limits: one for each visitor. */
  ip: string;
  /** Changes each page's HTML before its links are read: how a test takes a link away. */
  rewrite?: (html: string, path: string) => string;
};

/**
 * Crawls `site` from `/` as the visitor whose cookie and address `options` give, reading each
 * page's HTML on `parser`, a page of Chromium that shows nothing.
 */
export async function crawl(
  site: Site,
  parser: Page,
  { cookie, ip, rewrite }: CrawlOptions,
): Promise<CrawlResult> {
  const result: CrawlResult = { reached: new Map(), seen: new Set(), dead: [], capped: [] };
  const queue: { target: string; from: string }[] = [{ target: "/", from: "(start)" }];
  const queued = new Set<string>(["/"]);
  const perTemplate = new Map<string, number>();
  let fetches = 0;
  const headers: [string, string][] = [
    ["cf-connecting-ip", ip],
    ["user-agent", CRAWLER_USER_AGENT],
    ["accept", "text/html"],
  ];
  if (cookie !== undefined) headers.push(["cookie", cookie]);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { target, from } = next;
    const template = templateOf(target);
    const count = perTemplate.get(template) ?? 0;
    if (count >= PER_TEMPLATE) {
      if (!result.capped.includes(template)) result.capped.push(template);
      continue;
    }
    perTemplate.set(template, count + 1);
    // A path the redirects lead through is fetched with its query kept, but `next` is not read.
    let path = target;
    let res = await site.fetch(path, { headers });
    fetches += 1;
    for (let hop = 0; hop < MAX_REDIRECTS && res.status >= 300 && res.status < 400; hop += 1) {
      const location = res.headers.get("location");
      await res.arrayBuffer();
      const to = location === null ? null : sameSite(location, path);
      if (to === null) break;
      path = to;
      res = await site.fetch(path, { headers });
      fetches += 1;
    }
    if (fetches > MAX_FETCHES) {
      throw new Error(`the crawl made over ${MAX_FETCHES} fetches: a link is making new pages`);
    }
    const key = nodeKey(path);
    result.reached.set(key, res.status);
    const html = await res.text();
    if (res.status >= 400) result.dead.push({ from, to: target, status: res.status });
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || !type.includes("text/html")) continue;
    for (const found of await linkTargets(parser, rewrite?.(html, path) ?? html, path)) {
      const foundKey = nodeKey(found);
      result.seen.add(foundKey);
      if (queued.has(foundKey) || ADMIN_ACTION.test(foundKey)) continue;
      queued.add(foundKey);
      queue.push({ target: found, from: path });
    }
  }
  return result;
}

/** `entry`'s page as a path and query, by the `nodeKey` the crawl knows it by. */
const keyOf = (entry: InventoryPage, seeded: Inventory) => nodeKey(entry.path(seeded));

const listed = (unlinked: Unlinked[], entry: InventoryPage) =>
  unlinked.some(({ name }) => name === entry.name);

/**
 * The names of the pages in `pages` for `visitor` that the crawl did not reach with the status
 * the inventory gives them, leaving out those on the unlinked list.
 */
export function unreachedPages(
  result: CrawlResult,
  pages: InventoryPage[],
  seeded: Inventory,
  visitor: Visitor,
  unlinked: Unlinked[],
): string[] {
  return pages.flatMap((entry) => {
    if (entry.as !== visitor || listed(unlinked, entry)) return [];
    const reached = result.reached.get(keyOf(entry, seeded)) === (entry.status ?? 200);
    return reached ? [] : [entry.name];
  });
}

/**
 * The names of the pages in `pages` for `visitor` that are on the unlinked list and that a link
 * or form now leads to: entries to take off the list.
 */
export function staleUnlinked(
  result: CrawlResult,
  pages: InventoryPage[],
  seeded: Inventory,
  visitor: Visitor,
  unlinked: Unlinked[],
): string[] {
  const mine = pages.filter((entry) => entry.as === visitor);
  // An entry at the address of a page that has a link (too many requests is the search results
  // page, over the limit) is reached by that link and says nothing about its own.
  const linkedKeys = new Set(
    mine.flatMap((entry) => (listed(unlinked, entry) ? [] : [keyOf(entry, seeded)])),
  );
  return mine.flatMap((entry) => {
    const key = keyOf(entry, seeded);
    const stale = listed(unlinked, entry) && !linkedKeys.has(key) && result.seen.has(key);
    return stale ? [entry.name] : [];
  });
}

/** Throws, naming each, when `names` is not empty. */
export function assertNone(what: string, visitor: Visitor, names: string[]): void {
  if (names.length > 0) throw new Error(`${what} for ${visitor}: ${names.join(", ")}`);
}
