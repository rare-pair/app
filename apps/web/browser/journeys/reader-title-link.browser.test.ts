import { describe, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { seedReadableWork } from "../harness/seed";
import { SITE } from "../harness/site";

// NAV2: from the home page, the header's Search finds a work; from a chapter and from the
// entire work, the work's title in the reader bar goes back to the work page. AO3 work ids
// 43800-43899 are this item's; this file uses 43850, and apps/web/test/11-reader-bar-link uses
// 43800 to 43803. Every title and text is synthetic.
const WORK = 43850;
const TITLE = "Nav2Lanternfield Chronicle";

describe("reader title link journeys", () => {
  const running = useJourneySite();

  it("Search in the header finds a work, and a chapter's and the entire work's title go back to it", async () => {
    const { site } = running;
    await seedReadableWork(site, {
      ao3WorkId: WORK,
      title: TITLE,
      chapters: [1, 2].map((n) => ({
        title: `Chapter ${n}`,
        html: `<p>Synthetic sentence of nav2 chapter ${n}.</p>`,
        words: 10,
      })),
      chapterTotal: 2,
    });
    const page = await (await site.newContext()).newPage();
    const header = page.getByRole("banner");

    await page.goto(`${SITE}/`);
    await header.getByRole("link", { name: "Search" }).click();
    await page.waitForURL(`${SITE}/search`);
    await page.locator("#q").fill("Nav2Lanternfield");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/search" && url.searchParams.get("q") !== null),
      page.getByRole("button", { name: "Search" }).click(),
    ]);
    await page.getByRole("link", { name: TITLE, exact: true }).click();
    await page.waitForURL(`${SITE}/works/${WORK}`);

    // From a chapter, the title is a link named by the work's title.
    await page.locator(".chapters a").first().click();
    await page.waitForURL(`${SITE}/works/${WORK}/chapters/1`);
    await page.getByRole("heading", { level: 1 }).getByRole("link", { name: TITLE }).click();
    await page.waitForURL(`${SITE}/works/${WORK}`);

    // And from the entire work.
    await page.getByRole("link", { name: "Read the entire work on one page" }).click();
    await page.waitForURL(`${SITE}/works/${WORK}/full`);
    await page.getByRole("heading", { level: 1 }).getByRole("link", { name: TITLE }).click();
    await page.waitForURL(`${SITE}/works/${WORK}`);
  });
});
