import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_PAGES, PRELAUNCH_PAGES, type Visitor } from "../harness/pages";
import { signInLink } from "../harness/sessions";
import { SITE } from "../harness/site";
import { eachPage, useInventorySite } from "./inventory-suite";
import { formatWalk, tabTo, tabWalk } from "./keyboard";

// Spec 21's "Every action reachable by keyboard" case, in a real browser: Tab from the top of
// every page of the inventory reaches every link and control, in page order, each showing a
// focus ring (which is spec 21's "Focus rings always visible" too). The journeys below show
// each kind of control can be used from the keyboard. AO3 work ids 40920-40939 are this file's.

const SKIP = 'a "Skip to the main content"';

/** Presses `key` and waits for the page it leads to to load. */
async function pressToLoad(page: Page, key = "Enter") {
  await Promise.all([page.waitForEvent("load"), page.keyboard.press(key)]);
}

/** Whether focus is inside the page's <main>. */
const focusInMain = (page: Page) =>
  page.evaluate(() => (document.activeElement?.closest("main") ?? null) !== null);

/**
 * Chooses another option of the focused <select> by typing its label, as a keyboard user can
 * on every platform (arrow keys open the list on macOS instead), and returns its value.
 */
async function chooseAnother(page: Page): Promise<string> {
  const other = await page.evaluate(() => {
    const select = document.activeElement;
    if (!(select instanceof HTMLSelectElement)) throw new Error("no select has focus");
    const option = [...select.options].find((o) => o.value !== select.value);
    if (option === undefined) throw new Error("the select has one option");
    return { value: option.value, label: option.label };
  });
  await page.keyboard.type(other.label);
  return other.value;
}

/** Every page reached and walked by Tab: nothing missed, in order, with rings, skip link first. */
const walksClean = async (page: Page) => {
  const walk = await tabWalk(page);
  expect(formatWalk(walk)).toBe("");
  expect(walk.stops[0]).toBe(SKIP);
};

describe("21 accessibility and no-JS: Every action reachable by keyboard", () => {
  describe("before launch", () => {
    const running = useInventorySite({ prelaunch: true, firstId: 40930, prefix: "q1b-kbd-pre" });
    eachPage(PRELAUNCH_PAGES, running, walksClean);
  });

  describe("the archive open", () => {
    const running = useInventorySite({ prelaunch: false, firstId: 40920, prefix: "q1b-kbd" });
    eachPage(OPEN_PAGES, running, walksClean);

    // Each kind of control used from the keyboard alone: Tab to it, then Enter, Space or the
    // arrow keys. These change data (a report, a setting, an approval), so they run after
    // every page above has been walked. Admin buttons change data, so one moderator action
    // stands for them.
    describe("each kind of control can be used", () => {
      let page: Page;
      afterEach(() => page.close());

      const open = async (as: Visitor, path: string) => {
        page = await running.visitors.contexts[as].newPage();
        await page.goto(`${SITE}${path}`);
      };

      it("the skip link moves on to the main content", async () => {
        await open("anonymous", `/works/${running.seeded.work}`);
        await tabTo(page, SKIP);
        await page.keyboard.press("Enter");
        expect(new URL(page.url()).hash).toBe("#main");
        await page.keyboard.press("Tab");
        expect(await focusInMain(page)).toBe(true);
      });

      it("a link opens its page", async () => {
        await open("anonymous", `/works/${running.seeded.work}`);
        await tabTo(page, 'a "Chapter 3"');
        await pressToLoad(page);
        expect(page.url()).toBe(`${SITE}/works/${running.seeded.work}/chapters/3`);
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
        await open("anonymous", `/works/${running.seeded.work}/chapters/1`);
        await tabTo(page, "select n");
        const n = await chooseAnother(page);
        await tabTo(page, 'button "Go"');
        await pressToLoad(page);
        expect(page.url()).toBe(`${SITE}/works/${running.seeded.work}/chapters/${n}`);
      });

      it("reader settings: change one and save", async () => {
        await open("anonymous", "/settings/reader");
        await tabTo(page, "select theme");
        const theme = await chooseAnother(page);
        await tabTo(page, 'button "Save settings"');
        await pressToLoad(page);
        await page.goto(`${SITE}/settings/reader`);
        expect(await page.locator('select[name="theme"]').inputValue()).toBe(theme);
      });

      it("the warnings screen: Continue goes on to the work's text", async () => {
        const warned = running.seeded.warned;
        await open("anonymous", `/works/${warned}/chapters/1`);
        expect(new URL(page.url()).pathname).toBe(`/works/${warned}/warnings`);
        await tabTo(page, 'button "Continue"');
        await pressToLoad(page);
        expect(page.url()).toBe(`${SITE}/works/${warned}/chapters/1`);
      });

      it("radio buttons, a text area and a button: report a work", async () => {
        await open("reader", `/works/${running.seeded.work}/report`);
        await tabTo(page, "radio reason");
        await page.keyboard.press("Space");
        await tabTo(page, "textarea details");
        await page.keyboard.type("q1b-details");
        await tabTo(page, 'button "Send report"');
        await pressToLoad(page);
        expect(await page.getByRole("heading", { level: 1 }).textContent()).toMatch(/report/i);
        const sent = await running.site.db
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
        // Without the marker, as a browser that didn't ask: this one would press it by itself.
        await page.context().clearCookies({ name: "__Host-signin-pending" });
        await page.goto(await signInLink(running.site, email));
        await tabTo(page, 'button "Sign in"');
        await pressToLoad(page);
        expect(new URL(page.url()).pathname).toBe("/welcome/terms");
        await tabTo(page, 'button "I accept the terms"');
        await pressToLoad(page);
        expect(page.url()).toBe(`${SITE}/`);
      });

      it("a checkbox: Space ticks it", async () => {
        await open("anonymous", "/dmca");
        await tabTo(page, "input good_faith");
        await page.keyboard.press("Space");
        expect(await page.locator('input[name="good_faith"]').isChecked()).toBe(true);
      });

      it("a file field: Space opens the file chooser", async () => {
        await open("reader", "/upload");
        await tabTo(page, "input file");
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          page.keyboard.press("Space"),
        ]);
        expect(chooser.isMultiple()).toBe(true);
      });

      it("a moderator's button: approve a work to check", async () => {
        const toCheck = running.seeded.toCheck;
        await open("moderator", `/admin/works/${toCheck}`);
        await tabTo(page, 'button "Approve"');
        await pressToLoad(page);
        await page.goto(`${SITE}/admin/works`);
        expect(await page.getByText(`(${toCheck})`, { exact: false }).count()).toBe(0);
      });
    });
  });
});
