import type { Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { InventoryPage } from "../harness/pages";
import { seedInventory, type Inventory } from "../harness/seed";
import { SITE, startSite, type Site, type SiteOptions } from "../harness/site";
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
  viewport,
}: {
  prelaunch: boolean;
  firstId: number;
  prefix: string;
  /** The browser window's size; default the harness's (`viewportFromEnv()`). */
  viewport?: SiteOptions["viewport"];
}): InventorySite {
  // SAFETY: filled in by beforeAll, before any test in the block reads it.
  const running = {} as InventorySite;
  beforeAll(async () => {
    running.site = await startSite({ prelaunch, viewport });
    running.visitors = await openVisitors(running.site, prefix);
    running.seeded = await seedInventory(running.site, {
      firstId,
      uploader: running.visitors.readerId,
    });
  });
  // When startSite failed there is nothing to close, and its error is the one to see.
  afterAll(async () => {
    if ("site" in running) await running.site.close();
  });
  return running;
}

/**
 * One test per page of `pages`, named for it: opens the page as its visitor and runs `check`
 * on it. Before the check, the page must be the one the entry names (not a redirect away from
 * it) and answer the entry's status; after it, the page must have had no script or console
 * error and asked for nothing off the site but the stand-ins.
 */
export function eachPage(
  pages: InventoryPage[],
  running: InventorySite,
  check: (page: Page, entry: InventoryPage) => Promise<void>,
) {
  it.each(pages)("$name", async (entry) => {
    const { site, visitors, seeded } = running;
    const offSiteBefore = site.offSite.length;
    const { page, status, errors } = await visit(site, visitors, entry, seeded);
    try {
      const url = new URL(page.url());
      expect(url.origin + url.pathname + url.search).toBe(`${SITE}${entry.path(seeded)}`);
      expect(status).toBe(entry.status ?? 200);
      await check(page, entry);
      expect(errors).toEqual([]);
      expect(site.offSite.slice(offSiteBefore)).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
