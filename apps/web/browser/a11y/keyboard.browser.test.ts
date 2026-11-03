import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OPEN_PAGES, PRELAUNCH_PAGES, type InventoryPage } from "../harness/pages";
import { seedInventory, type Inventory } from "../harness/seed";
import { signInLink } from "../harness/sessions";
import { SITE, startSite, type Site } from "../harness/site";
import { openVisitors, visit, type Visitors } from "../harness/visit";
import { formatWalk, tabTo, tabWalk } from "./keyboard";

// Spec 21's "Every action reachable by keyboard" case, in a real browser: Tab from the top of
// every page of the inventory reaches every link and control, in page order, each showing a
// focus ring (which is spec 21's "Focus rings always visible" too). The journeys below show
// each kind of control can be used from the keyboard. AO3 work ids 40920-40949 are this file's.

const SKIP = 'a "Skip to the main content"';

/** A suite that walks each of `pages` by Tab, on a site started with `prelaunch`. */
function tabSuite(title: string, pages: InventoryPage[], prelaunch: boolean, firstId: number) {
  describe(title, () => {
    let site: Site;
    let visitors: Visitors;
    let seeded: Inventory;
    beforeAll(async () => {
      site = await startSite({ prelaunch });
      visitors = await openVisitors(site, `q1b-kbd-${firstId}`);
      seeded = await seedInventory(site, { firstId, uploader: visitors.readerId });
    });
    afterAll(() => site.close());

    it.each(pages)("$name", async (entry) => {
      const { page, status } = await visit(site, visitors, entry, seeded);
      try {
        expect(status).toBe(entry.status ?? 200);
        const walk = await tabWalk(page);
        expect(formatWalk(walk)).toBe("");
        expect(walk.stops[0]).toBe(SKIP);
      } finally {
        await page.close();
      }
    });
  });
}

/** Presses `key` and waits for the page it leads to to load. */
async function pressToLoad(page: Page, key = "Enter") {
  await Promise.all([page.waitForEvent("load"), page.keyboard.press(key)]);
}

/** Whether focus is inside the page's <main>. */
const focusInMain = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("main") !== null);

describe("21 accessibility and no-JS: Every action reachable by keyboard", () => {
  tabSuite("the archive open", OPEN_PAGES, false, 40920);
  tabSuite("before launch", PRELAUNCH_PAGES, true, 40930);

  // Each kind of control used from the keyboard alone: Tab to it, then Enter, Space or the
  // arrow keys. Admin buttons change data, so one moderator action stands for them.
  describe("each kind of control can be used", () => {
    let site: Site;
    let visitors: Visitors;
    let seeded: Inventory;
    let page: Page;
    beforeAll(async () => {
      site = await startSite();
      visitors = await openVisitors(site, "q1b-kbd-use");
      seeded = await seedInventory(site, { firstId: 40940, uploader: visitors.readerId });
    });
    afterAll(() => site.close());
    afterEach(() => page.close());

    const open = async (as: keyof Visitors["contexts"], path: string) => {
      page = await visitors.contexts[as].newPage();
      await page.goto(`${SITE}${path}`);
    };

    it("the skip link moves on to the main content", async () => {
      await open("anonymous", `/works/${seeded.work}`);
      await tabTo(page, SKIP);
      await page.keyboard.press("Enter");
      expect(new URL(page.url()).hash).toBe("#main");
      await page.keyboard.press("Tab");
      expect(await focusInMain(page)).toBe(true);
    });

    it("a link opens its page", async () => {
      await open("anonymous", `/works/${seeded.work}`);
      await tabTo(page, 'a "Chapter 3"');
      await pressToLoad(page);
      expect(page.url()).toBe(`${SITE}/works/${seeded.work}/chapters/3`);
    });

    it("search: type a query and press Enter", async () => {
      await open("anonymous", "/");
      await tabTo(page, "input q");
      await page.keyboard.type("q1b");
      await pressToLoad(page);
      expect(page.url()).toBe(`${SITE}/search?q=q1b`);
      const results = page.getByRole("link", { name: "q1b-Work in three chapters" });
      expect(await results.count()).toBeGreaterThan(0);
    });

    it("a select and a button: jump to a chapter", async () => {
      await open("anonymous", `/works/${seeded.work}/chapters/1`);
      await tabTo(page, "select n");
      await page.keyboard.press("ArrowDown");
      await tabTo(page, 'button "Go"');
      await pressToLoad(page);
      expect(page.url()).toBe(`${SITE}/works/${seeded.work}/chapters/2`);
    });

    it("reader settings: change one and save", async () => {
      await open("anonymous", "/settings/reader");
      const before = await page.locator('select[name="theme"]').inputValue();
      await tabTo(page, "select theme");
      await page.keyboard.press("ArrowDown");
      await tabTo(page, 'button "Save settings"');
      await pressToLoad(page);
      await page.goto(`${SITE}/settings/reader`);
      expect(await page.locator('select[name="theme"]').inputValue()).not.toBe(before);
    });

    it("the warnings screen: Continue goes on to the work's text", async () => {
      await open("anonymous", `/works/${seeded.warned}/chapters/1`);
      expect(new URL(page.url()).pathname).toBe(`/works/${seeded.warned}/warnings`);
      await tabTo(page, 'button "Continue"');
      await pressToLoad(page);
      expect(page.url()).toBe(`${SITE}/works/${seeded.warned}/chapters/1`);
    });

    it("radio buttons, a text area and a button: report a work", async () => {
      await open("reader", `/works/${seeded.work}/report`);
      await tabTo(page, "radio reason");
      await page.keyboard.press("Space");
      await tabTo(page, "textarea details");
      await page.keyboard.type("q1b-details");
      await tabTo(page, 'button "Send report"');
      await pressToLoad(page);
      expect(await page.getByRole("heading", { level: 1 }).textContent()).toMatch(/report/i);
      const sent = await site.db
        .selectFrom("reports")
        .select("body")
        .where("body", "=", "q1b-details")
        .execute();
      expect(sent).toHaveLength(1);
    });

    it("a form behind Turnstile: sign in, open the emailed link and accept the terms", async () => {
      const email = "q1b-kbd-signin@example.test";
      await open("anonymous", "/login");
      await tabTo(page, "input email");
      await page.keyboard.type(email);
      await pressToLoad(page);
      expect(await page.getByText("check your email", { exact: false }).count()).toBe(1);
      await page.goto(await signInLink(site, email));
      await tabTo(page, 'button "Sign in"');
      await pressToLoad(page);
      expect(new URL(page.url()).pathname).toBe("/welcome/terms");
      await tabTo(page, 'button "I accept the terms"');
      await pressToLoad(page);
      expect(page.url()).toBe(`${SITE}/`);
    });

    it("a moderator's button: approve a work to check", async () => {
      await open("moderator", `/admin/works/${seeded.toCheck}`);
      await tabTo(page, 'button "Approve"');
      await pressToLoad(page);
      await page.goto(`${SITE}/admin/works`);
      expect(await page.getByText(`(${seeded.toCheck})`, { exact: false }).count()).toBe(0);
    });
  });
});
