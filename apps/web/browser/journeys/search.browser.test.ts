import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { seedReadableWork } from "../harness/seed";
import { useJourneySite } from "../harness/journey";
import { SITE } from "../harness/site";
import { startAtHome } from "../harness/walk";

// AO3 work ids 42140-42163 are this file's. One work has a word of its own in its title, its
// byline and its tag; 22 more share another word in their titles, for a second page of two: the
// first two are Explicit, and the last is in a different fandom. A 23rd, hidden, shares it too.
const ALPHA = "Pw4Alphaverse";
const BETA = "Pw4Betaverse";
const SHARED = "Pw4Wanderlight";
const ZEPHYR = "Pw4 Zephyrine Chronicle";

describe("search journey", () => {
  const running = useJourneySite();

  const cards = (page: Page) => page.locator("ol.work-list .card-title a").allInnerTexts();
  /**
   * Submits the form on the page, and waits for the results' URL. A browser sends every field of
   * a GET form, blank ones too, so the URL is read without its blank parameters.
   */
  async function submit(page: Page, search: string) {
    await Promise.all([
      page.waitForURL((url) => {
        const given = [...url.searchParams].filter(([, value]) => value !== "");
        return url.pathname === "/search" && new URLSearchParams(given).toString() === search;
      }),
      page.getByRole("button", { name: "Search" }).click(),
    ]);
  }
  async function search(page: Page, q: string) {
    await page.locator("#q").fill(q);
    await submit(page, `q=${q}`);
  }

  it("Search finds a seeded work by title, tag and author, with filters and pages", async () => {
    const { site } = running;
    await seedReadableWork(site, {
      ao3WorkId: 42140,
      title: ZEPHYR,
      authors: [{ pseud: "Pw4Quillmaker", ao3_user: null }],
      tags: [
        { type: "fandom", name: ALPHA },
        { type: "freeform", name: "Pw4Moonlit" },
      ],
    });
    for (let i = 0; i < 21; i += 1) {
      await seedReadableWork(site, {
        ao3WorkId: 42141 + i,
        title: `${SHARED} Tale ${String(i).padStart(2, "0")}`,
        rating: i < 2 ? "Explicit" : "General Audiences",
        tags: [{ type: "fandom", name: BETA }],
      });
    }
    await seedReadableWork(site, {
      ao3WorkId: 42162,
      title: `${SHARED} Tale Rival`,
      rating: "General Audiences",
      tags: [{ type: "fandom", name: ALPHA }],
    });
    await seedReadableWork(site, {
      ao3WorkId: 42163,
      title: `${SHARED} Tale Hidden`,
      status: "hidden",
      hiddenCause: "moderator",
      tags: [{ type: "fandom", name: BETA }],
    });

    const page = await startAtHome(await site.newContext());

    // By title from the home page's box, then by tag, then by author, from the results' form.
    await search(page, "Pw4Zephyrine");
    expect(await cards(page)).toEqual([ZEPHYR]);
    await search(page, "Pw4Moonlit");
    expect(await cards(page)).toEqual([ZEPHYR]);
    await search(page, "Pw4Quillmaker");
    expect(await cards(page)).toEqual([ZEPHYR]);

    // Twenty-two works share the word, over two pages, and the hidden one is not among them.
    await search(page, SHARED);
    const first = await cards(page);
    expect(first).toHaveLength(20);
    await Promise.all([
      page.waitForURL(`${SITE}/search?q=${SHARED}&page=2`),
      page.getByRole("link", { name: "Next" }).click(),
    ]);
    const second = await cards(page);
    expect(second).toHaveLength(2);
    const all = [...first, ...second];
    expect(new Set(all).size).toBe(22);
    expect(all.every((t) => t.startsWith(SHARED))).toBe(true);
    expect(all).not.toContain(`${SHARED} Tale Hidden`);

    // The fandom filter narrows them to the one in it; submitting returns to the first page.
    await page.locator("#search-fandom").fill(ALPHA);
    await submit(page, `q=${SHARED}&fandom=${ALPHA}`);
    expect(await cards(page)).toEqual([`${SHARED} Tale Rival`]);

    // The rating filter narrows them to the two Explicit ones.
    await page.locator("#search-fandom").fill("");
    await page.locator("#search-rating").selectOption("Explicit");
    await submit(page, `q=${SHARED}&rating=Explicit`);
    expect((await cards(page)).sort()).toEqual([`${SHARED} Tale 00`, `${SHARED} Tale 01`]);
  });
});
