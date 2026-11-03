import type { BrowserContext, Page } from "playwright";
import type { InventoryPage, Visitor } from "./pages";
import type { Inventory } from "./seed";
import { signedIn } from "./sessions";
import { SITE, type Site } from "./site";

/** A browser context for each kind of visitor, and the reader's user id. */
export type Visitors = { contexts: Record<Visitor, BrowserContext>; readerId: string };

/**
 * Opens a context for each visitor: one signed out, and three signed in with addresses
 * `<prefix>-reader@example.test`, `<prefix>-moderator@...` and `<prefix>-new@...`.
 */
export async function openVisitors(site: Site, prefix: string): Promise<Visitors> {
  const [anonymous, reader, moderator, fresh] = await Promise.all([
    site.newContext(),
    signedIn(site, { email: `${prefix}-reader@example.test` }),
    signedIn(site, { email: `${prefix}-moderator@example.test`, role: "moderator" }),
    signedIn(site, { email: `${prefix}-new@example.test`, acceptTerms: false }),
  ]);
  return {
    contexts: {
      anonymous,
      reader: reader.context,
      moderator: moderator.context,
      "new account": fresh.context,
    },
    readerId: reader.userId,
  };
}

/**
 * Opens `entry`, at its path for the ids in `seeded`, in a new page of its visitor's context
 * (or, for an entry with `prepare`, of a new context with the options it returns), and waits
 * for it to load. Returns the page, the status it answered with, and `errors`: every script
 * error and console error the page has had (a CSP refusal is one), which goes on filling
 * while the page is open. Close the page when done.
 */
export async function visit(
  site: Site,
  { contexts }: Visitors,
  entry: InventoryPage,
  seeded: Inventory,
): Promise<{ page: Page; status: number; errors: string[] }> {
  let context = contexts[entry.as];
  if (entry.prepare !== undefined) {
    const own = await site.newContext(await entry.prepare(site));
    context = own;
    own.on("page", (page) => page.once("close", () => void own.close()));
  }
  const page = await context.newPage();
  const url = new URL(entry.path(seeded), SITE).toString();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Chromium logs the page's own error status (a 404 or a 429 page) as a failed load.
    const ownStatus =
      message.location().url === url &&
      message.text().startsWith("Failed to load resource: the server responded with a status");
    if (!ownStatus) errors.push(message.text());
  });
  const response = await page.goto(url);
  return { page, status: response?.status() ?? 0, errors };
}
