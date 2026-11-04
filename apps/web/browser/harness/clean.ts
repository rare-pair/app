import type { BrowserContext } from "playwright";

/** What a test may have expected to go wrong: a problem matching one of these is excused. */
export type CleanOptions = { allow?: RegExp[] };

/**
 * Collects what a clean page never does, across every page of every context it watches:
 * script errors, console errors (Chromium logs one for every CSP violation and every refused
 * or failed load) and requests the site refused as off-site.
 */
export function cleanCheck(offSite: string[]) {
  const contexts: BrowserContext[] = [];
  const problems: string[] = [];
  let offSiteSeen = 0;
  return {
    watch(context: BrowserContext) {
      contexts.push(context);
      context.on("weberror", (error) => problems.push(`script error: ${error.error().message}`));
      context.on("console", (message) => {
        if (message.type() === "error") {
          problems.push(`console error: ${message.text()} (${message.location().url})`);
        }
      });
    },
    /**
     * Throws, listing every problem since the last call, and forgets them either way. A round
     * trip to each open page first brings in what its script has already reported, since
     * Chromium delivers console messages in order but later than the code that logged them.
     */
    assertClean: async ({ allow = [] }: CleanOptions = {}) => {
      const pages = contexts.flatMap((context) => context.pages());
      await Promise.allSettled(pages.map((page) => page.evaluate("0")));
      const found = [
        ...problems.splice(0),
        ...offSite.slice(offSiteSeen).map((url) => `off-site request: ${url}`),
      ].filter((problem) => !allow.some((allowed) => allowed.test(problem)));
      offSiteSeen = offSite.length;
      if (found.length > 0) throw new Error(`The page wasn't clean:\n${found.join("\n")}`);
    },
  };
}
