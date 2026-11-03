import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";

/** One axe rule's outcome on a page, with the elements it found. */
export type AxeResult = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

/**
 * WCAG 2.2 AA in axe's tags: each version's A and AA rules, since a version's tag holds only
 * the criteria it added (axe-core's API.md). wcag22a has no rules in axe 4.14.
 */
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export type AxeReport = {
  /** WCAG 2.2 AA rules the page fails: the suite fails on these. */
  violations: AxeResult[];
  /** WCAG rules axe could not decide ("needs review"): reported, not failed. */
  incomplete: AxeResult[];
  /** axe's best-practice rules the page fails: reported, not failed. */
  bestPractice: AxeResult[];
};

/** Whether a rule is one of WCAG 2.2 AA's, by its tags. */
const isWcag = (r: AxeResult) => r.tags.some((tag) => WCAG_22_AA.includes(tag));

/**
 * Runs axe on the page as it is, once, with the WCAG 2.2 AA and best-practice rules, and
 * sorts the results by rule (axe judges each rule on its own). axe is injected through the
 * page's evaluate, which the site's CSP doesn't govern, so the page keeps its own policy.
 */
export async function checkAxe(page: Page): Promise<AxeReport> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_22_AA, "best-practice"])
    .analyze();
  return {
    violations: results.violations.filter(isWcag),
    incomplete: results.incomplete.filter(isWcag),
    bestPractice: results.violations.filter((r) => !isWcag(r)),
  };
}

/**
 * Results as text, one rule a paragraph: its id, impact and help, then each element's CSS
 * target and axe's summary of what to fix. Empty for none, so a passing page compares to "".
 */
export const formatResults = (results: AxeResult[]) =>
  results
    .map((r) =>
      [
        `${r.id} (${r.impact ?? "no impact"}): ${r.help}`,
        ...r.nodes.map(
          (n) => `  ${n.target.join(" ")}: ${(n.failureSummary ?? "").replace(/\s+/g, " ")}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
