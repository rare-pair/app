import { normalizeTagName } from "@archive/db";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { tagHref } from "../../src/tag-links";
import { seedReadableWork } from "../harness/seed";
import { useJourneySite } from "../harness/journey";
import { SITE } from "../harness/site";

const FANDOM = "Pw4 Listing Fandom";
const PATH = tagHref("fandom", normalizeTagName("fandom", FANDOM));
const title = (i: number) => `Pw4 Listing Work ${String(i).padStart(2, "0")}`;

// AO3 work ids 42100-42121 are this file's: work i has id 42100 + i, and a page holds 20, so
// 22 works make a second page of two. Work i was updated on day i + 1 of January 2021, so by
// default the newest (21) is first and page 2 holds works 1 and 0. Work 5 has by far the most
// words. Works 4, 9 and 14 are Explicit, 9 and 14 are complete, and only 9 has a second tag.
const COUNT = 22;
const EXPLICIT = [4, 9, 14];
const COMPLETE = [9, 14];

describe("tag listing journey", () => {
  const running = useJourneySite();

  const cards = (page: Page) => page.locator("ol.work-list .card-title a").allInnerTexts();
  /**
   * Applies the form as it stands, and waits for the page it navigates to. A browser sends every
   * field of a GET form, blank ones too, so the URL is read without its blank parameters.
   */
  async function apply(page: Page, search: string) {
    await Promise.all([
      page.waitForURL((url) => {
        // The tag's type is always sent, but means nothing without a tag.
        const hasTag = url.searchParams.get("tag") !== "" && url.searchParams.has("tag");
        const given = [...url.searchParams].filter(
          ([key, value]) => value !== "" && (key !== "tag_type" || hasTag),
        );
        return url.pathname === PATH && new URLSearchParams(given).toString() === search.slice(1);
      }),
      page.getByRole("button", { name: "Apply" }).click(),
    ]);
  }

  it("A tag listing's sort, filters and pages change the results and keep the URL shareable", async () => {
    const { site } = running;
    for (let i = 0; i < COUNT; i += 1) {
      await seedReadableWork(site, {
        ao3WorkId: 42100 + i,
        title: title(i),
        rating: EXPLICIT.includes(i) ? "Explicit" : "General Audiences",
        complete: COMPLETE.includes(i),
        updatedAt: `2021-01-${String(i + 1).padStart(2, "0")}`,
        tags: [
          { type: "fandom", name: FANDOM },
          ...(i === 9 ? [{ type: "freeform" as const, name: "Pw4extra" }] : []),
        ],
        chapters: [{ words: i === 5 ? 5000 : 100 + i * 10 }],
      });
    }

    const page = await (await site.newContext()).newPage();
    await page.goto(`${SITE}${PATH}`);
    expect(await page.locator("h1").innerText()).toBe(`${FANDOM} (fandom)`);
    expect(await cards(page)).toEqual(Array.from({ length: 20 }, (_, n) => title(COUNT - 1 - n)));

    // Page 2 holds the rest, by the same sort.
    await Promise.all([
      page.waitForURL(`${SITE}${PATH}?page=2`),
      page.getByRole("link", { name: "Next" }).click(),
    ]);
    expect(await cards(page)).toEqual([title(1), title(0)]);
    expect(await page.locator('nav.pager [aria-current="page"]').innerText()).toBe("2");

    // Sorted by words, work 5 leads; the pager's next page keeps the sort.
    await page.locator("#listing-sort").selectOption("words");
    await apply(page, "?sort=words");
    expect((await cards(page))[0]).toBe(title(5));
    expect(await cards(page)).toHaveLength(20);
    await Promise.all([
      page.waitForURL(`${SITE}${PATH}?sort=words&page=2`),
      page.getByRole("link", { name: "Next" }).click(),
    ]);
    expect(await cards(page)).toEqual([title(1), title(0)]);

    // Each filter narrows the results and adds to the URL; with few left, there is no pager.
    await page.locator("#listing-rating").selectOption("Explicit");
    await apply(page, "?sort=words&rating=Explicit");
    expect(await cards(page)).toEqual([title(14), title(9), title(4)]);
    expect(await page.locator("nav.pager").count()).toBe(0);

    await page.locator("#listing-complete").selectOption("yes");
    await apply(page, "?sort=words&rating=Explicit&complete=yes");
    expect(await cards(page)).toEqual([title(14), title(9)]);

    await page.locator("#listing-tag-type").selectOption("freeform");
    await page.locator("#listing-tag").fill("pw4extra");
    const shareable = "?sort=words&rating=Explicit&complete=yes&tag=pw4extra&tag_type=freeform";
    await apply(page, shareable);
    expect(await cards(page)).toEqual([title(9)]);

    // The URL is shareable: asked for alone, from nowhere, it answers with the same card.
    const shared = await site.fetch(`${PATH}${shareable}`);
    expect(shared.status).toBe(200);
    const html = await shared.text();
    expect(html).toContain(title(9));
    expect(html).not.toContain(title(14));
  });
});
