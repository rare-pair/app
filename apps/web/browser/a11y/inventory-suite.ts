import type { Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { InventoryPage } from "../harness/pages";
import { seedInventory, type Inventory } from "../harness/seed";
import { startSite, type Site } from "../harness/site";
import { openVisitors, visit, type Visitors } from "../harness/visit";

/** The site an inventory suite runs on, ready once its `beforeAll` has run. */
export type InventorySite = { site: Site; visitors: Visitors; seeded: Inventory };

/**
 * In the enclosing describe block, starts a site (`prelaunch` as given), opens its visitors
 * with addresses starting `prefix`, and seeds the inventory with AO3 work ids from `firstId`;
 * closes it after. Returns the running site, filled in once `beforeAll` has run.
 */
export function useInventorySite({
  prelaunch,
  firstId,
  prefix,
}: {
  prelaunch: boolean;
  firstId: number;
  prefix: string;
}): InventorySite {
  // SAFETY: filled in by beforeAll, before any test in the block reads it.
  const running = {} as InventorySite;
  beforeAll(async () => {
    running.site = await startSite({ prelaunch });
    running.visitors = await openVisitors(running.site, prefix);
    running.seeded = await seedInventory(running.site, {
      firstId,
      uploader: running.visitors.readerId,
    });
  });
  afterAll(() => running.site.close());
  return running;
}

/**
 * One test per page of `pages`, named for it: opens the page as its visitor, checks the
 * status it answers with, then runs `check` on it.
 */
export function eachPage(
  pages: InventoryPage[],
  running: InventorySite,
  check: (page: Page, entry: InventoryPage) => Promise<void>,
) {
  it.each(pages)("$name", async (entry) => {
    const { page, status } = await visit(running.site, running.visitors, entry, running.seeded);
    try {
      expect(status).toBe(entry.status ?? 200);
      await check(page, entry);
    } finally {
      await page.close();
    }
  });
}
