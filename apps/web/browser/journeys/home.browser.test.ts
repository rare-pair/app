import { normalizeTagName } from "@archive/db";
import { describe, expect, it } from "vitest";
import { tagHref } from "../../src/tag-links";
import { expectAgentNoticeHidden } from "../harness/agent-notice";
import { seedReadableWork } from "../harness/seed";
import { useJourneySite } from "../harness/journey";
import { SITE } from "../harness/site";
import { startAtHome } from "../harness/walk";

const BIG = "Pw4 Home Bigverse";
const SMALL = "Pw4 Home Smallverse";
const fandomPath = (name: string) => tagHref("fandom", normalizeTagName("fandom", name));

// AO3 work ids 42180-42189 are this file's. Three works in BIG and two in SMALL make the order
// of "Popular fandoms" known, and `addedAt` makes the order of "Recently added" known.
const WORKS = [
  { id: 42180, title: "Pw4 Home Oldest", fandom: BIG, addedAt: "2026-01-01T00:00:00Z" },
  { id: 42181, title: "Pw4 Home Second", fandom: BIG, addedAt: "2026-01-02T00:00:00Z" },
  { id: 42182, title: "Pw4 Home Third", fandom: BIG, addedAt: "2026-01-03T00:00:00Z" },
  { id: 42183, title: "Pw4 Home Fourth", fandom: SMALL, addedAt: "2026-01-04T00:00:00Z" },
  { id: 42184, title: "Pw4 Home Newest", fandom: SMALL, addedAt: "2026-01-05T00:00:00Z" },
];

describe("home journey", () => {
  const running = useJourneySite();

  it("The agent notice on the home page is hidden from people and screen readers", async () => {
    await expectAgentNoticeHidden(await startAtHome(await running.site.newContext()));
  });

  it("The home page lists fandoms and recent works, and each link lands", async () => {
    const { site } = running;
    for (const w of WORKS) {
      await seedReadableWork(site, {
        ao3WorkId: w.id,
        title: w.title,
        tags: [{ type: "fandom", name: w.fandom }],
        addedAt: w.addedAt,
      });
    }
    // Hidden works are left out of both lists, though they are the newest. Counted, they would
    // put SMALL (4) ahead of BIG (3).
    for (const id of [42185, 42186]) {
      await seedReadableWork(site, {
        ao3WorkId: id,
        title: `Pw4 Home Hidden ${id}`,
        status: "hidden",
        hiddenCause: "moderator",
        tags: [{ type: "fandom", name: SMALL }],
        addedAt: "2026-01-06T00:00:00Z",
      });
    }

    const page = await startAtHome(await site.newContext());
    const titles = () => page.locator("ol.work-list .card-title a").allInnerTexts();
    expect(await page.locator("ul.fandom-list a").allInnerTexts()).toEqual([BIG, SMALL]);
    expect(await titles()).toEqual(WORKS.map((w) => w.title).reverse());

    // A fandom link lands on its listing, which holds that fandom's works.
    await Promise.all([
      page.waitForURL(`${SITE}${fandomPath(SMALL)}`),
      page.locator("ul.fandom-list").getByRole("link", { name: SMALL }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe(`${SMALL} (fandom)`);
    // (Same update date, so the listing falls back to the lower id first.)
    expect(await titles()).toEqual(["Pw4 Home Fourth", "Pw4 Home Newest"]);

    // Back, a work card's title lands on its work page.
    await page.goBack();
    await expect.poll(() => page.url()).toBe(`${SITE}/`);
    await Promise.all([
      page.waitForURL(`${SITE}/works/42182`),
      page.locator(".card-title").getByRole("link", { name: "Pw4 Home Third" }).click(),
    ]);
    expect(await page.locator("h1").innerText()).toBe("Pw4 Home Third");
  });
});
