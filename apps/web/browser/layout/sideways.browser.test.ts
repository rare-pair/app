import { describe, expect, it } from "vitest";
import { eachPage, useInventorySite } from "../a11y/inventory-suite";
import { hasSidewaysScroll, sidewaysOffenders } from "../harness/layout";
import { OPEN_PAGES, PRELAUNCH_PAGES } from "../harness/pages";
import { visit } from "../harness/visit";

// Spec 21's "No sideways scrolling at 360 px": every page of the inventory, in the default
// light theme and reader size, in a 360 by 640 window set here (not by BROWSER_VIEWPORT, so
// a plain `npm run test:browser` always checks it). AO3 work ids 41300-41316 are this file's.

const VIEWPORT = { width: 360, height: 640 };

describe("21 accessibility and no-JS: no sideways scrolling at 360 px", () => {
  for (const [title, pages, prelaunch, firstId] of [
    ["the archive open", OPEN_PAGES, false, 41300],
    ["before launch", PRELAUNCH_PAGES, true, 41310],
  ] as const) {
    describe(title, () => {
      const running = useInventorySite({
        prelaunch,
        firstId,
        prefix: `q1c-sideways-${firstId}`,
        viewport: VIEWPORT,
      });
      // Without this a harness that dropped the option would pass every page vacuously.
      it("is checked in a 360 px window", async () => {
        const { page } = await visit(running.site, running.visitors, pages[0]!, running.seeded);
        try {
          expect(page.viewportSize()?.width).toBe(360);
        } finally {
          await page.close();
        }
      });
      eachPage(pages, running, async (page) => {
        const wide = await hasSidewaysScroll(page);
        expect(wide ? await sidewaysOffenders(page) : []).toEqual([]);
        expect(wide).toBe(false);
      });
    });
  }
});
