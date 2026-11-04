import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";

// The site header, as a person meets it: from the home page, each link is there by its role
// and name and goes where it says. Which links each visitor gets on every page is
// apps/web/test/20-site-header; this is the click-through. Addresses are synthetic.

describe("site header journeys", () => {
  const running = useJourneySite();

  it("Signed out: Add work asks to sign in, Sign in opens the sign-in page", async () => {
    const { site } = running;
    const page = await (await site.newContext()).newPage();
    await page.goto(`${SITE}/`);
    const header = page.getByRole("banner");
    expect(await header.getByRole("link").allInnerTexts()).toEqual([
      "rarepair",
      "Search",
      "Add work",
      "Sign in",
    ]);
    expect(await header.getByRole("button").count()).toBe(0);

    await header.getByRole("link", { name: "Search" }).click();
    await page.waitForURL(`${SITE}/search`);
    await page.getByRole("searchbox", { name: "Search the archive" }).waitFor();

    await page.goto(`${SITE}/`);
    await header.getByRole("link", { name: "Add work" }).click();
    await page.waitForURL(`${SITE}/login?next=%2Fupload`);

    await page.goto(`${SITE}/`);
    await header.getByRole("link", { name: "Sign in" }).click();
    await page.waitForURL(`${SITE}/login`);
    await page.getByRole("heading", { level: 1 }).waitFor();
  });

  it("Signed in: Add work and My uploads open their pages, and there is no Sign in", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "nav-reader@example.test" });
    const page = await context.newPage();
    await page.goto(`${SITE}/`);
    const header = page.getByRole("banner");
    expect(await header.getByRole("link").allInnerTexts()).toEqual([
      "rarepair",
      "Search",
      "Add work",
      "My uploads",
    ]);
    expect(await header.getByRole("button", { name: "Sign out" }).count()).toBe(1);
    expect(await header.getByRole("link", { name: "Sign in" }).count()).toBe(0);
    expect(await header.getByRole("link", { name: "Admin" }).count()).toBe(0);

    await header.getByRole("link", { name: "Add work" }).click();
    await page.waitForURL(`${SITE}/upload`);
    await page.getByRole("heading", { name: "Upload a work" }).waitFor();

    await header.getByRole("link", { name: "My uploads" }).click();
    await page.waitForURL(`${SITE}/me/uploads`);
    await page.getByRole("heading", { level: 1 }).waitFor();
  });

  it("Sign out works from the keyboard: Tab to the button, Enter, and the header is the signed-out one", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "nav-keyboard-out@example.test" });
    const page = await context.newPage();
    await page.goto(`${SITE}/`);
    const header = page.getByRole("banner");

    const reached: string[] = [];
    for (let i = 0; i < 12 && !reached.includes("Sign out"); i += 1) {
      await page.keyboard.press("Tab");
      // SAFETY: after a Tab, the focused element is one of the page's links or buttons.
      const focused = () => (document.activeElement as HTMLElement).innerText;
      reached.push(await page.evaluate(focused));
    }
    expect(reached.at(-1)).toBe("Sign out");

    await page.keyboard.press("Enter");
    await header.getByRole("link", { name: "Sign in" }).waitFor();
    expect(await header.getByRole("button", { name: "Sign out" }).count()).toBe(0);
    expect(await header.getByRole("link", { name: "My uploads" }).count()).toBe(0);
  });

  it("A moderator's Admin opens /admin, and Sign out is reachable by keyboard", async () => {
    const { site } = running;
    const { context } = await signedIn(site, {
      email: "nav-moderator@example.test",
      role: "moderator",
    });
    const page = await context.newPage();
    await page.goto(`${SITE}/`);
    const header = page.getByRole("banner");
    expect(await header.getByRole("link").allInnerTexts()).toEqual([
      "rarepair",
      "Search",
      "Add work",
      "My uploads",
      "Admin",
    ]);

    // Tab from the top reaches each control in the header's order.
    const reached: string[] = [];
    for (let i = 0; i < 12 && !reached.includes("Sign out"); i += 1) {
      await page.keyboard.press("Tab");
      // SAFETY: after a Tab, the focused element is one of the page's links or buttons.
      const focused = () => (document.activeElement as HTMLElement).innerText;
      reached.push(await page.evaluate(focused));
    }
    const names = ["Search", "Add work", "My uploads", "Admin", "Sign out"];
    expect(reached.filter((name) => names.includes(name))).toEqual(names);

    await header.getByRole("link", { name: "Admin" }).click();
    await page.waitForURL(`${SITE}/admin`);
    await page.getByRole("heading", { level: 1 }).waitFor();
  });
});
