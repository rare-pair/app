import type { BrowserContext, Page } from "playwright";
import type { InventoryPage, Visitor } from "./pages";
import type { Inventory } from "./seed";
import { signedIn } from "./sessions";
import { freshIp, SITE, type Site } from "./site";

/** A browser context for each kind of visitor, and the reader's user id. */
export type Visitors = { contexts: Record<Visitor, BrowserContext>; readerId: string };

/**
 * Opens a context for each visitor: one signed out, and three signed in with addresses
 * `<prefix>-reader@example.test`, `<prefix>-moderator@...` and `<prefix>-new@...`.
 */
export async function openVisitors(site: Site, prefix: string): Promise<Visitors> {
  const reader = await signedIn(site, { email: `${prefix}-reader@example.test` });
  const moderator = await signedIn(site, {
    email: `${prefix}-moderator@example.test`,
    role: "moderator",
  });
  const fresh = await signedIn(site, { email: `${prefix}-new@example.test`, acceptTerms: false });
  return {
    contexts: {
      anonymous: await site.newContext(),
      reader: reader.context,
      moderator: moderator.context,
      "new account": fresh.context,
    },
    readerId: reader.userId,
  };
}

/**
 * Fills the search limit for client `ip`: searches from Node until the Worker answers 429,
 * so the browser's next search from that address, made at once, is refused in the same
 * window.
 */
async function fillSearchLimit(site: Site, ip: string) {
  for (let i = 0; i < 100; i += 1) {
    const res = await site.fetch("/search?q=q1b", { headers: { "cf-connecting-ip": ip } });
    await res.arrayBuffer();
    if (res.status === 429) return;
  }
  throw new Error("the search limit never answered 429");
}

/**
 * Opens `entry`, at its path for the ids in `seeded`, in a new page of its visitor's context,
 * and waits for it to load. Returns the page and the status it answered with. Close the page
 * when done.
 */
export async function visit(
  site: Site,
  { contexts }: Visitors,
  entry: InventoryPage,
  seeded: Inventory,
): Promise<{ page: Page; status: number }> {
  let context = contexts[entry.as];
  if (entry.overSearchLimit) {
    const ip = freshIp();
    context = await site.newContext({ ip });
    await fillSearchLimit(site, ip);
  }
  const page = await context.newPage();
  const response = await page.goto(new URL(entry.path(seeded), SITE).toString());
  if (entry.overSearchLimit) page.once("close", () => void context.close());
  return { page, status: response?.status() ?? 0 };
}
