import { afterAll, describe, expect } from "vitest";
import { OPEN_PAGES, PRELAUNCH_PAGES } from "../harness/pages";
import { checkAxe, formatResults, type AxeResult } from "./axe";
import { eachPage, useInventorySite } from "./inventory-suite";

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

describe("21 accessibility and no-JS: WCAG 2.2 AA", () => {
  for (const [title, pages, prelaunch, firstId] of [
    ["the archive open", OPEN_PAGES, false, 40900],
    ["before launch", PRELAUNCH_PAGES, true, 40910],
  ] as const) {
    describe(title, () => {
      const running = useInventorySite({ prelaunch, firstId, prefix: `q1b-wcag-${firstId}` });
      eachPage(pages, running, async (page, entry) => {
        const report = await checkAxe(page);
        note(entry.name, "needs review", report.incomplete);
        note(entry.name, "best practice", report.bestPractice);
        expect(formatResults(report.violations)).toBe("");
      });
    });
  }
});
