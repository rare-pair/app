import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  linkTargets,
  nodeKey,
  staleUnlinked,
  templateOf,
  unreachedPages,
  type CrawlResult,
} from "./crawl";
import { OPEN_PAGES, PRELAUNCH_PAGES, type InventoryPage } from "./pages";
import type { Inventory } from "./seed";
import { launchChromium } from "./site";
import { UNLINKED } from "./unlinked";

// The crawler's own parts, on HTML written here and results built here: each must fail what
// it is there to catch, or a pass on the site shows nothing. No site runs.

let browser: Browser;
let parser: Page;

beforeAll(async () => {
  browser = await launchChromium();
  parser = await (await browser.newContext()).newPage();
});
afterAll(() => browser.close());

const targets = (html: string, from = "/works/1") => linkTargets(parser, html, from);

describe("crawl: link targets", () => {
  it("takes same-site links, relative or absolute, and leaves the rest", async () => {
    const html = `
      <a href="/about">a</a><a href="chapters/2">b</a>
      <a href="https://rarepair.fans/terms">c</a>
      <a href="https://example.test/elsewhere">d</a><a href="mailto:x@example.test">e</a>
      <a href="#main">f</a><a>no href</a><a href="/privacy#top">g</a>`;
    expect(await targets(html)).toEqual(["/about", "/works/chapters/2", "/terms", "/privacy"]);
  });

  it("follows a form that gets, with its fields' own values, and never one that posts", async () => {
    const html = `
      <form method="post" action="/logout"><button>Sign out</button></form>
      <form action="/works/1/chapters"><select name="chapter">
        <option value="1">one</option><option value="2" selected>two</option></select>
        <input type="hidden" name="h" value="x"><input type="checkbox" name="off" value="1">
        <input type="checkbox" name="on" value="1" checked><button name="go" value="1">Go</button>
      </form>`;
    expect(await targets(html)).toEqual(["/works/1/chapters?chapter=2&h=x&on=1"]);
  });

  it("takes no form that gets back to the page it is on, which only filters it", async () => {
    const html = `<form action="/tags/fandom/x"><select name="sort"><option>updated</option></select></form>`;
    expect(await targets(html, "/tags/fandom/x")).toEqual([]);
    expect(await targets(html, "/")).toEqual(["/tags/fandom/x?sort=updated"]);
  });

  it("fills the search box from the crawler's table, and also tries it empty", async () => {
    const html = `<form role="search" action="/search"><input type="search" name="q" value=""></form>`;
    expect(await targets(html)).toEqual(["/search?q=q1b", "/search?q="]);
  });
});

describe("crawl: node keys", () => {
  it("drops next and empty parameters, keeps the rest, in a fixed order", () => {
    expect(nodeKey("/settings/reader?next=%2Fworks%2F1")).toBe("/settings/reader");
    expect(nodeKey("/search?q=")).toBe("/search");
    expect(nodeKey("/search?q=q1b")).toBe("/search?q=q1b");
    expect(nodeKey("/x?b=2&a=1")).toBe("/x?a=1&b=2");
    expect(nodeKey("/login?error=INVALID_TOKEN")).toBe("/login?error=INVALID_TOKEN");
  });

  it("makes one template of the pages of a kind", () => {
    expect(templateOf("/works/4/chapters/2")).toBe("/works/:id/chapters/:id");
    expect(templateOf("/works/5/chapters/9")).toBe("/works/:id/chapters/:id");
    expect(templateOf("/tags/fandom/q1b-Fandom")).toBe("/tags/:type/:name");
    expect(templateOf("/about")).toBe("/about");
  });
});

// A result as the crawl returns it, with the pages `reached` and the targets `seen`.
const result = (reached: string[], seen: string[] = []): CrawlResult => ({
  reached: new Map(reached.map((key) => [key, 200])),
  seen: new Set([...reached, ...seen]),
  dead: [],
  capped: [],
});
// SAFETY: the pages here have paths that ignore the seeded ids.
const seeded = {} as Inventory;
const page = (name: string, path: string, extra: Partial<InventoryPage> = {}): InventoryPage => ({
  name,
  path: () => path,
  as: "anonymous",
  ...extra,
});

describe("crawl: what is unreached", () => {
  it("names an inventory page of the visitor that was not reached", () => {
    const pages = [page("about", "/about"), page("terms", "/terms")];
    expect(unreachedPages(result(["/about"]), pages, seeded, "anonymous", [])).toEqual(["terms"]);
  });

  it("leaves out pages of another visitor and pages on the unlinked list", () => {
    const pages = [
      page("admin", "/admin", { as: "moderator" }),
      page("sign out", "/logout"),
      page("about", "/about"),
    ];
    const unlinked = [{ name: "sign out", reason: "a button" }];
    expect(unreachedPages(result(["/about"]), pages, seeded, "anonymous", unlinked)).toEqual([]);
  });

  it("names a page reached with another status than the inventory says", () => {
    const reached = new Map([["/gone", 200]]);
    const run = { ...result([]), reached };
    const pages = [page("removed", "/gone", { status: 410 })];
    expect(unreachedPages(run, pages, seeded, "anonymous", [])).toEqual(["removed"]);
  });

  it("names a page on the unlinked list that a link now reaches", () => {
    const pages = [page("sign out", "/logout"), page("not found", "/nope", { status: 404 })];
    const unlinked = [
      { name: "sign out", reason: "a button" },
      { name: "not found", reason: "by nature" },
    ];
    expect(staleUnlinked(result([], ["/logout"]), pages, seeded, "anonymous", unlinked)).toEqual([
      "sign out",
    ]);
  });
});

describe("crawl: a stale unlinked entry", () => {
  it("is not named when its address is also a page that has a link", () => {
    const pages = [
      page("search results", "/search?q=q1b"),
      page("too many requests", "/search?q=q1b", { status: 429 }),
    ];
    const unlinked = [{ name: "too many requests", reason: "over a limit" }];
    const found = result(["/search?q=q1b"]);
    expect(staleUnlinked(found, pages, seeded, "anonymous", unlinked)).toEqual([]);
  });
});

describe("crawl: the unlinked list", () => {
  it("names only pages of the inventory, each once, each with a reason", () => {
    const names = new Set([...OPEN_PAGES, ...PRELAUNCH_PAGES].map((entry) => entry.name));
    const listed = UNLINKED.map((entry) => entry.name);
    expect(listed.filter((name) => !names.has(name))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(UNLINKED.filter((entry) => entry.reason.trim() === "")).toEqual([]);
  });
});
