import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_PAGES, PRELAUNCH_PAGES, type InventoryPage } from "../harness/pages";
import { seedInventory, type Inventory } from "../harness/seed";
import { startSite, type Site } from "../harness/site";
import { openVisitors, visit, type Visitors } from "../harness/visit";
import { checkAxe, formatResults, type AxeResult } from "./axe";

// Spec 21's WCAG 2.2 AA case, in a real browser: axe's WCAG 2.2 AA rules on every page of
// the inventory, in the default light theme, with the archive open and before launch. Rules
// axe can't decide ("needs review") and its best-practice rules are printed once the file is
// done, not failed (rulings on #505). AO3 work ids 40900-40919 are this file's.

/** What axe reported but didn't fail, by page. */
const reported: string[] = [];
const note = (name: string, kind: string, results: AxeResult[]) => {
  if (results.length > 0) reported.push(`${name}, ${kind}:\n${formatResults(results)}`);
};
afterAll(() => {
  // Not console.log: vitest drops a passing file's console output.
  process.stdout.write(
    reported.length === 0
      ? "axe, not failing: nothing to report\n"
      : `axe, not failing:\n\n${reported.join("\n\n")}\n`,
  );
});

/** A suite that runs axe on each of `pages`, on a site started with `prelaunch`. */
function wcagSuite(title: string, pages: InventoryPage[], prelaunch: boolean, firstId: number) {
  describe(title, () => {
    let site: Site;
    let visitors: Visitors;
    let seeded: Inventory;
    beforeAll(async () => {
      site = await startSite({ prelaunch });
      visitors = await openVisitors(site, `q1b-wcag-${firstId}`);
      seeded = await seedInventory(site, { firstId, uploader: visitors.readerId });
    });
    afterAll(() => site.close());

    it.each(pages)("$name", async (entry) => {
      const { page, status } = await visit(site, visitors, entry, seeded);
      try {
        expect(status).toBe(entry.status ?? 200);
        const report = await checkAxe(page);
        note(entry.name, "needs review", report.incomplete);
        note(entry.name, "best practice", report.bestPractice);
        expect(formatResults(report.violations)).toBe("");
        // Nothing off the site but the stand-ins: the page was checked as it would load.
        expect(site.offSite).toEqual([]);
      } finally {
        await page.close();
      }
    });
  });
}

describe("21 accessibility and no-JS: WCAG 2.2 AA", () => {
  wcagSuite("the archive open", OPEN_PAGES, false, 40900);
  wcagSuite("before launch", PRELAUNCH_PAGES, true, 40910);
});
