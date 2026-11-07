import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { eachPage, useInventorySite, type InventorySite } from "../a11y/inventory-suite";
import { footerBottomAtEnd, measureFill } from "../harness/layout";
import { OPEN_PAGES, PRELAUNCH_PAGES, type InventoryPage } from "../harness/pages";
import { visit } from "../harness/visit";

// Spec 20's "A short page fills the screen" and "A long page scrolls with the footer after
// its content", with the column checks the layout rule needs. AO3 work ids 61100-61199 are
// this file's: each window seeds two sites, from 61100 and 61110 and from 61120 and 61130.

const WINDOWS = [
  { name: "1280 by 800", width: 1280, height: 800, firstId: 61100 },
  { name: "360 px wide", width: 360, height: 640, firstId: 61120 },
] as const;

// Short at both sizes (a sentence, or a sentence and a form), so they fit without scrolling.
const SHORT_OPEN = ["not found", "confirm sign-in"];
// The coming-soon page is short at 1280 by 800 only: at 360 by 640 it scrolls on its own.
const COMING_SOON = ["coming soon"];
// Long at both sizes: the entire work. (A seeded chapter fits an 800 px window.)
const LONG_OPEN = ["entire work"];
// Every kind of page the layout covers, short or long: the footer ends the page.
const EVERY_KIND_OPEN = ["not found", "confirm sign-in", "chapter", "entire work", "admin"];

const named = (pages: InventoryPage[], names: string[]) =>
  pages.filter((entry) => names.includes(entry.name));

const measureOpen = async (running: InventorySite, name: string) => {
  const entry = OPEN_PAGES.find((p) => p.name === name)!;
  const { page } = await visit(running.site, running.visitors, entry, running.seeded);
  try {
    return await measureFill(page);
  } finally {
    await page.close();
  }
};

for (const win of WINDOWS) {
  describe(`20 site chrome and legal: pages fill the screen, ${win.name}`, () => {
    const viewport = { width: win.width, height: win.height };
    const open = useInventorySite({
      prelaunch: false,
      firstId: win.firstId,
      prefix: `fill-open-${win.width}`,
      viewport,
    });
    const before = useInventorySite({
      prelaunch: true,
      firstId: win.firstId + 10,
      prefix: `fill-before-${win.width}`,
      viewport,
    });

    // Without this a harness that dropped the option would pass every page vacuously.
    it("is checked in a window of the size named", async () => {
      const { page } = await visit(open.site, open.visitors, OPEN_PAGES[0]!, open.seeded);
      try {
        expect(page.viewportSize()).toEqual(viewport);
      } finally {
        await page.close();
      }
    });

    describe("A short page fills the screen", () => {
      const check = async (page: Page) => {
        const fill = await measureFill(page);
        expect(fill.scrollHeight).toBeLessThanOrEqual(fill.innerHeight);
        expect(Math.abs(fill.footer.bottom - fill.innerHeight)).toBeLessThanOrEqual(1);
        expect(fill.main.bottom).toBeLessThanOrEqual(fill.footer.top);
      };
      eachPage(named(OPEN_PAGES, SHORT_OPEN), open, check);
      if (win.width === 1280) eachPage(named(PRELAUNCH_PAGES, COMING_SOON), before, check);
    });

    describe("A long page scrolls with the footer after its content", () => {
      eachPage(named(OPEN_PAGES, LONG_OPEN), open, async (page) => {
        const fill = await measureFill(page);
        expect(fill.scrollHeight).toBeGreaterThan(fill.innerHeight);
        expect(fill.footer.top).toBeGreaterThanOrEqual(fill.main.bottom);
        // The whole of the content can be reached: at the end of the page the footer ends at
        // the window's bottom edge, with the content above it.
        expect(Math.abs((await footerBottomAtEnd(page)) - fill.innerHeight)).toBeLessThanOrEqual(1);
      });
    });

    describe("Holds on the layout's pages of every kind", () => {
      const check = async (page: Page) => {
        const fill = await measureFill(page);
        expect(fill.main.bottom).toBeLessThanOrEqual(fill.footer.top);
        expect(Math.abs((await footerBottomAtEnd(page)) - fill.innerHeight)).toBeLessThanOrEqual(1);
      };
      eachPage(named(OPEN_PAGES, EVERY_KIND_OPEN), open, check);
      eachPage(named(PRELAUNCH_PAGES, COMING_SOON), before, check);
    });

    describe("The header, main and footer keep their column width and centring", () => {
      it("is the same on a short page and a long one, with the banner full width", async () => {
        const short = await measureOpen(open, "not found");
        const long = await measureOpen(open, "entire work");
        for (const fill of [short, long]) {
          for (const column of [fill.header, fill.main, fill.footer]) {
            // Centred: the gaps either side are equal.
            expect(Math.abs(column.left - (fill.innerWidth - column.right))).toBeLessThanOrEqual(1);
          }
        }
        for (const part of ["header", "main", "footer"] as const) {
          expect(short[part].width).toBeCloseTo(long[part].width, 0);
          expect(short[part].left).toBeCloseTo(long[part].left, 0);
        }
        expect(short.header.width).toBeCloseTo(short.main.width, 0);
        // The footer's text is smaller than main's, but its column is the same width.
        expect(short.footer.width).toBeCloseTo(short.main.width, 0);
        if (win.width === 1280) {
          // The site's width is one constant, about 960 px.
          expect(short.main.width).toBeCloseTo(960, 0);
        } else {
          // A narrow window: the column is the whole width.
          expect(short.main.width).toBe(short.innerWidth);
          expect(short.footer.width).toBe(short.innerWidth);
        }
        for (const fill of [short, long]) {
          if (fill.banner) expect(fill.banner.width).toBe(fill.innerWidth);
        }
      });
    });

    describe("Prose and chapters keep a readable measure in the wider column", () => {
      it("keeps a paragraph and a chapter under 800 px at 1280, and in the window at 360", async () => {
        const widthOf = async (name: string, selector: string) => {
          const entry = OPEN_PAGES.find((p) => p.name === name)!;
          const { page } = await visit(open.site, open.visitors, entry, open.seeded);
          try {
            return await page
              .locator(selector)
              .first()
              .evaluate((el) => el.getBoundingClientRect().width);
          } finally {
            await page.close();
          }
        };
        const paragraph = await widthOf("not found", "main > p");
        const chapter = await widthOf("chapter", "article.chapter");
        const post = await widthOf("update post", ".update-body");
        const summary = await widthOf("work", "section.summary");
        if (win.width === 1280) {
          expect(paragraph).toBeLessThan(800);
          expect(chapter).toBeLessThan(800);
          expect(post).toBeLessThan(800);
          expect(summary).toBeLessThan(800);
          // The chapter keeps the line length it had before the site widened: the old column,
          // 66ch of the interface font, 569.25 px here.
          expect(chapter).toBeCloseTo(569.25, 0);
        } else {
          for (const width of [paragraph, chapter, post, summary]) {
            expect(width).toBeGreaterThan(0);
            expect(width).toBeLessThanOrEqual(360);
          }
        }
      });
    });

    describe("The reading column is centred, with its heading and navigation lined up", () => {
      for (const name of ["chapter", "entire work"]) {
        it(`on the ${name} page`, async () => {
          const entry = OPEN_PAGES.find((p) => p.name === name)!;
          const { page } = await visit(open.site, open.visitors, entry, open.seeded);
          try {
            const box = async (selector: string) => {
              const found = page.locator(selector).first();
              if ((await found.count()) === 0) return null;
              return found.evaluate((el) => {
                const r = el.getBoundingClientRect();
                return { left: r.left, right: r.right, width: r.width };
              });
            };
            const article = (await box("article.chapter"))!;
            const innerWidth = await page.evaluate(() => window.innerWidth);
            expect(Math.abs(article.left - (innerWidth - article.right))).toBeLessThanOrEqual(1);
            for (const selector of [".chapter-title", ".chapter-nav", "p.back"]) {
              const other = await box(selector);
              if (!other) continue;
              expect(Math.abs(other.left - article.left), selector).toBeLessThanOrEqual(1);
            }
          } finally {
            await page.close();
          }
        });
      }
    });

    describe("The search box and button are compact but still touch targets", () => {
      it("is between 32 and 40 px tall", async () => {
        const entry = OPEN_PAGES.find((p) => p.name === "not found")!;
        const { page } = await visit(open.site, open.visitors, entry, open.seeded);
        try {
          for (const selector of ['form[role="search"] input', 'form[role="search"] button']) {
            const height = await page
              .locator(selector)
              .evaluate((el) => el.getBoundingClientRect().height);
            expect(height).toBeGreaterThanOrEqual(32);
            expect(height).toBeLessThanOrEqual(40);
          }
        } finally {
          await page.close();
        }
      });
    });

    describe("The skip link and the keyboard order", () => {
      it("shows the skip link on the first Tab and Enter moves to the main content", async () => {
        const entry = OPEN_PAGES.find((p) => p.name === "not found")!;
        const { page } = await visit(open.site, open.visitors, entry, open.seeded);
        try {
          await page.keyboard.press("Tab");
          const skip = page.locator("a.skip");
          expect(await skip.evaluate((el) => el === document.activeElement)).toBe(true);
          expect((await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
          await page.keyboard.press("Enter");
          expect(new URL(page.url()).hash).toBe("#main");
        } finally {
          await page.close();
        }
      });
    });
  });
}
