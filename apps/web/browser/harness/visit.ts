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
 * for it to load. Returns the page and the status it answered with. Close the page when done.
 */
export async function visit(
  site: Site,
  { contexts }: Visitors,
  entry: InventoryPage,
  seeded: Inventory,
): Promise<{ page: Page; status: number }> {
  let context = contexts[entry.as];
  if (entry.prepare !== undefined) {
    const own = await site.newContext(await entry.prepare(site));
    context = own;
    own.on("page", (page) => page.once("close", () => void own.close()));
  }
  const page = await context.newPage();
  const response = await page.goto(new URL(entry.path(seeded), SITE).toString());
  return { page, status: response?.status() ?? 0 };
}
