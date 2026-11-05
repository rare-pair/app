import type { BrowserContext, Page, Response } from "playwright";
import { SITE } from "./site";

// How a journey gets about the way a person does: from the home page, by the links on it.
// A journey's main path starts with `startAtHome`, and moves with `viaHeader`, `viaFooter` and
// `viaSearch` (a live work, found by its title);
// `byAddress` is the one way to a URL, for what a person really gets as one (an emailed link,
// a bookmark, a page with no link to it), and it takes the reason so the reason can be read.

/** Whether `page` is on the site, as opposed to blank or somewhere else. */
const onSite = (page: Page) => new URL(page.url()).origin === new URL(SITE).origin;

/** Opens a new page in `context` on the home page, where a journey's main path starts. */
export async function startAtHome(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${SITE}/`);
  return page;
}

/** Clicks the link `name` in `landmark` and waits for the page to load. */
async function clickIn(page: Page, landmark: "banner" | "contentinfo", name: string) {
  // A blank page, or one off the site, has no header: begin where a person would, at home.
  if (!onSite(page)) await page.goto(`${SITE}/`);
  const link = page.getByRole(landmark).getByRole("link", { name, exact: true });
  await Promise.all([page.waitForEvent("load"), link.click()]);
}

/** Clicks the header's link `name`, from the page `page` is on (from home when it is on none). */
export const viaHeader = (page: Page, name: string) => clickIn(page, "banner", name);

/** Clicks the footer's link `name`, from the page `page` is on (from home when it is on none). */
export const viaFooter = (page: Page, name: string) => clickIn(page, "contentinfo", name);

/**
 * From the page `page` is on (from home when it is on none), clicks the header's Search, searches
 * for `title`, clicks the one result named exactly that and returns the response for the work's
 * page. For a live work a person has no address for: they find it as this does. The title must
 * match no other result's.
 */
export async function viaSearch(page: Page, title: string): Promise<Response> {
  await viaHeader(page, "Search");
  await page.locator("#q").fill(title);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Search", exact: true }).click(),
  ]);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().isNavigationRequest() && r.request().frame() === page.mainFrame(),
    ),
    page.getByRole("link", { name: title, exact: true }).click(),
  ]);
  return res;
}

/**
 * Opens `path` by its address. `why` says why a person has this address and no link to it
 * (an emailed link, a saved bookmark, a typed address a no-JavaScript check needs); it is
 * required so every direct address in a journey gives its reason, and a search for
 * `byAddress` lists them.
 */
export async function byAddress(page: Page, path: string, why: string): Promise<Response | null> {
  if (why.trim() === "") throw new Error(`byAddress(${path}) needs the reason for the address`);
  return page.goto(`${SITE}${path}`);
}
