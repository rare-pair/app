import { describe, expect, it } from "vitest";
import { seedReadableWork } from "../harness/seed";
import { useJourneySite } from "../harness/journey";
import { SITE } from "../harness/site";
import { startAtHome } from "../harness/walk";

// AO3 work ids 43000-43001 and this fandom are this file's.
const FANDOM = "Pw All Works Fandom";
const EXPLICIT = "Pw All Works Explicit";
const GENERAL = "Pw All Works General";

describe("all works journey", () => {
  const running = useJourneySite();

  it("From the home page, a reader reaches every live work and narrows it with the form", async () => {
    const { site } = running;
    await seedReadableWork(site, {
      ao3WorkId: 43000,
      title: EXPLICIT,
      rating: "Explicit",
      // Newest of all, so both are on the first page whatever other journeys have seeded.
      updatedAt: "2099-01-02",
      tags: [{ type: "fandom", name: FANDOM }],
    });
    await seedReadableWork(site, {
      ao3WorkId: 43001,
      title: GENERAL,
      rating: "General Audiences",
      updatedAt: "2099-01-01",
      tags: [{ type: "fandom", name: FANDOM }],
    });

    const page = await startAtHome(await site.newContext());
    await Promise.all([
      page.waitForURL(`${SITE}/search`),
      page.getByRole("link", { name: "All works", exact: true }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("Search");
    const titles = () => page.locator("ol.work-list .card-title a").allInnerTexts();
    expect(await titles()).toEqual(expect.arrayContaining([EXPLICIT, GENERAL]));

    // The GET form narrows to this fandom's Explicit works, and the choice is in the URL.
    await page.locator("#listing-rating").selectOption("Explicit");
    await page.locator("#listing-tag").fill(FANDOM);
    await page.locator("#listing-tag-type").selectOption("fandom");
    await Promise.all([
      page.waitForURL(
        (url) => url.pathname === "/search" && url.searchParams.get("rating") === "Explicit",
      ),
      page.getByRole("button", { name: "Search" }).click(),
    ]);
    expect(await titles()).toEqual([EXPLICIT]);

    // The card leads to the work page, as every listing's does.
    await Promise.all([
      page.waitForURL(`${SITE}/works/43000`),
      page.getByRole("link", { name: EXPLICIT, exact: true }).click(),
    ]);
  });
});
