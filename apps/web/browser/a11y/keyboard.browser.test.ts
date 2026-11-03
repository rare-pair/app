import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_PAGES, PRELAUNCH_PAGES, type InventoryPage } from "../harness/pages";
import { seedInventory, type Inventory } from "../harness/seed";
import { startSite, type Site } from "../harness/site";
import { openVisitors, visit, type Visitors } from "../harness/visit";
import { formatWalk, tabWalk } from "./keyboard";

// Spec 21's "Every action reachable by keyboard" case, in a real browser: Tab from the top of
// every page of the inventory reaches every link and control, in page order, each showing a
// focus ring (which is spec 21's "Focus rings always visible" too). The journeys below show
// each kind of control can be used from the keyboard. AO3 work ids 40920-40939 are this file's.

const SKIP = 'a "Skip to the main content"';

/** A suite that walks each of `pages` by Tab, on a site started with `prelaunch`. */
function tabSuite(title: string, pages: InventoryPage[], prelaunch: boolean, firstId: number) {
  describe(title, () => {
    let site: Site;
    let visitors: Visitors;
    let seeded: Inventory;
    beforeAll(async () => {
      site = await startSite({ prelaunch });
      visitors = await openVisitors(site, `q1b-kbd-${firstId}`);
      seeded = await seedInventory(site, { firstId, uploader: visitors.readerId });
    });
    afterAll(() => site.close());

    it.each(pages)("$name", async (entry) => {
      const { page, status } = await visit(site, visitors, entry, seeded);
      try {
        expect(status).toBe(entry.status ?? 200);
        const walk = await tabWalk(page);
        expect(formatWalk(walk)).toBe("");
        expect(walk.stops[0]).toBe(SKIP);
      } finally {
        await page.close();
      }
    });
  });
}

describe("21 accessibility and no-JS: Every action reachable by keyboard", () => {
  tabSuite("the archive open", OPEN_PAGES, false, 40920);
  tabSuite("before launch", PRELAUNCH_PAGES, true, 40930);
});
