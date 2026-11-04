import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { SITE, startSite, type Site, type SiteOptions } from "./site";

/** The site a journey runs on, ready once its `beforeAll` has run. */
export type JourneySite = { site: Site };

/**
 * In the enclosing describe block, starts a site and closes it after. Every test in the block
 * then fails on a CSP violation, a console or script error or an unexpected off-site request;
 * a test expecting some, such as an error page's own status line, calls
 * `site.assertClean({ allow })` itself before it ends.
 */
export function useJourneySite(options?: SiteOptions): JourneySite {
  // SAFETY: filled in by beforeAll, before any test in the block reads it.
  const running = {} as JourneySite;
  beforeAll(async () => {
    running.site = await startSite(options);
  });
  afterEach(() => {
    if ("site" in running) running.site.assertClean();
  });
  // When startSite failed there is nothing to close, and its error is the one to see.
  afterAll(async () => {
    if ("site" in running) await running.site.close();
  });
  return running;
}

/** The path of a committed synthetic epub, by its file name under fixtures/epubs/synthetic. */
export const syntheticEpub = (name: string) =>
  join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/epubs/synthetic", name);

/**
 * Uploads the file at `path` through `/upload` as a signed-in `page` does, until the page says
 * it was accepted, and returns the upload's id. Follow with `site.waitForUpload(id)`.
 */
export async function uploadThroughPage(
  site: Site,
  page: Page,
  userId: string,
  path: string,
): Promise<string> {
  await page.goto(`${SITE}/upload`);
  await page.setInputFiles("#file", path);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect.poll(() => page.locator("#files").innerText()).toContain("Uploaded.");
  const { id } = await site.db
    .selectFrom("uploads")
    .select("id")
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
  return id;
}
