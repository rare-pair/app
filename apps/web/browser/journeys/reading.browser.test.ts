import type { Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { useJourneySite, type JourneySite } from "../harness/journey";
import { seedReadableWork } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";

// A reader moves through works with the scripts running and the CSP enforced. The works are
// seeded straight into the database and bucket: ingest is not what these prove (the upload
// journey does). AO3 work ids 42000-42099 are this file's; every title and text is synthetic.
const NAVIGATION = 42000;
const WARNED_A = 42001;
const WARNED_B = 42002;
const SETTINGS = 42003;
const POSITION = 42004;
const HIDDEN = 42005;
const REMOVED = 42006;
const WARNED_POSITION = 42007;

const chapterHtml = (label: string, paragraphs: number) =>
  Array.from(
    { length: paragraphs },
    (_, i) => `<p>Synthetic sentence ${i + 1} of ${label}.</p>`,
  ).join("");

const warnings = [
  { type: "warning" as const, name: "Graphic Depictions Of Violence" },
  { type: "warning" as const, name: "Major Character Death" },
];

/** Seeds every work this file reads, once, as soon as the site is up. */
function seedWorks(running: JourneySite) {
  beforeAll(async () => {
    const { site } = running;
    await seedReadableWork(site, {
      ao3WorkId: NAVIGATION,
      title: "pw3-Work in three chapters",
      rating: "General Audiences",
      chapters: [1, 2, 3].map((n) => ({
        title: `Chapter ${n}`,
        html: chapterHtml(`pw3 navigation chapter ${n}`, 2),
        words: 20,
      })),
      chapterTotal: 3,
    });
    for (const [ao3WorkId, title] of [
      [WARNED_A, "pw3-Warned work A"],
      [WARNED_B, "pw3-Warned work B"],
    ] as const) {
      await seedReadableWork(site, {
        ao3WorkId,
        title,
        rating: "Mature",
        tags: warnings,
        chapters: [1, 2].map((n) => ({
          title: `Chapter ${n}`,
          html: chapterHtml(`pw3 warned ${ao3WorkId} chapter ${n}`, 2),
          words: 20,
        })),
        chapterTotal: 2,
      });
    }
    await seedReadableWork(site, {
      ao3WorkId: SETTINGS,
      title: "pw3-Settings work",
      rating: "General Audiences",
      chapters: [{ title: "Chapter 1", html: chapterHtml("pw3 settings", 6), words: 60 }],
    });
    for (const [ao3WorkId, rating, tags] of [
      [POSITION, "General Audiences", undefined],
      [WARNED_POSITION, "Mature", warnings],
    ] as const) {
      await seedReadableWork(site, {
        ao3WorkId,
        title: `pw3-Position work ${ao3WorkId}`,
        rating,
        tags,
        chapters: [
          { title: "Chapter 1", html: chapterHtml(`pw3 position ${ao3WorkId}`, 120), words: 1200 },
        ],
      });
    }
    await seedReadableWork(site, {
      ao3WorkId: HIDDEN,
      title: "pw3-Hidden work",
      status: "hidden",
      hiddenCause: "moderator",
      chapters: [{ title: "Chapter 1", html: chapterHtml("pw3 hidden", 2), words: 20 }],
    });
    await seedReadableWork(site, {
      ao3WorkId: REMOVED,
      title: "pw3-Removed work",
      status: "removed",
      chapters: [{ title: "Chapter 1", html: chapterHtml("pw3 removed", 2), words: 20 }],
    });
  });
}

/** How far the page can scroll, and how far it has. */
const scrollState = (page: Page) =>
  page.evaluate(() => ({
    y: window.scrollY,
    room: document.documentElement.scrollHeight - window.innerHeight,
  }));

/** The text of the page's main element. */
const mainText = (page: Page) => page.locator("main").innerText();

/**
 * Scrolls to halfway down the page and waits for the position script's save (5 seconds after
 * the scroll; never sleep) to be answered 204.
 */
async function saveHalfway(page: Page, ao3WorkId: number, room: number) {
  const [saved] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url() === `${SITE}/works/${ao3WorkId}/position` && res.request().method() === "POST",
    ),
    page.evaluate((to) => window.scrollTo(0, to), Math.floor(room / 2)),
  ]);
  expect(saved.status()).toBe(204);
}

describe("reading journeys", () => {
  const running = useJourneySite();
  seedWorks(running);

  it("Chapter select and previous and next move between chapters, and the entire work shows every chapter", async () => {
    const { site } = running;
    const page = await (await site.newContext()).newPage();
    const nav = page.locator("nav.chapter-nav").first();

    await page.goto(`${SITE}/works/${NAVIGATION}`);
    await page.locator(".chapters a").first().click();
    await page.waitForURL(`${SITE}/works/${NAVIGATION}/chapters/1`);
    expect(await nav.getByRole("link", { name: "Previous chapter" }).count()).toBe(0);

    await nav.getByRole("link", { name: "Next chapter" }).click();
    await page.waitForURL(`${SITE}/works/${NAVIGATION}/chapters/2`);
    expect(await mainText(page)).toContain("pw3 navigation chapter 2");

    await nav.getByRole("link", { name: "Previous chapter" }).click();
    await page.waitForURL(`${SITE}/works/${NAVIGATION}/chapters/1`);

    // The real form: a GET, then the Worker's 303 to the chapter.
    await page.locator("#chapter-top").selectOption("3");
    await Promise.all([page.waitForEvent("load"), nav.getByRole("button", { name: "Go" }).click()]);
    await page.waitForURL(`${SITE}/works/${NAVIGATION}/chapters/3`);
    expect(await mainText(page)).toContain("pw3 navigation chapter 3");
    expect(await nav.getByRole("link", { name: "Next chapter" }).count()).toBe(0);
    expect(await nav.getByRole("link", { name: "Previous chapter" }).count()).toBe(1);

    // The page streams: the last heading is there once the whole of it has been parsed.
    await page.goto(`${SITE}/works/${NAVIGATION}/full`);
    await page.locator("h2#chapter-3").waitFor();
    expect(await page.locator("article.chapter").count()).toBe(3);
    expect(await page.locator("h2.chapter-title").count()).toBe(3);
    for (const n of [1, 2, 3]) {
      expect(await mainText(page)).toContain(`pw3 navigation chapter ${n}`);
    }
  });

  it("A work with warnings stops at the warnings screen and Continue reaches the chapter", async () => {
    const { site } = running;
    const page = await (await site.newContext()).newPage();

    await page.goto(`${SITE}/works/${WARNED_A}/chapters/1`);
    const url = new URL(page.url());
    expect(url.pathname).toBe(`/works/${WARNED_A}/warnings`);
    expect(url.searchParams.get("next")).toBe(`/works/${WARNED_A}/chapters/1`);
    expect(await mainText(page)).toContain("Rating: Mature");
    expect(await page.locator("ul.warnings li").allInnerTexts()).toEqual([
      "Graphic Depictions Of Violence",
      "Major Character Death",
    ]);
    expect(await mainText(page)).not.toContain(`pw3 warned ${WARNED_A}`);
    // Signed out: no turn-off tick.
    expect(await page.getByLabel("Don't show this screen again").count()).toBe(0);

    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Continue" }).click(),
    ]);
    await page.waitForURL(`${SITE}/works/${WARNED_A}/chapters/1`);
    expect(await mainText(page)).toContain(`pw3 warned ${WARNED_A} chapter 1`);

    // The session cookie remembers the work: its next chapter opens with no screen.
    await page.goto(`${SITE}/works/${WARNED_A}/chapters/2`);
    await page.waitForURL(`${SITE}/works/${WARNED_A}/chapters/2`);
    expect(await mainText(page)).toContain(`pw3 warned ${WARNED_A} chapter 2`);
  });

  it("A signed-in reader who turned the warnings screen off skips it", async () => {
    const { site } = running;
    const { context, userId } = await signedIn(site, { email: "pw3-skips-warnings@example.test" });
    const page = await context.newPage();

    await page.goto(`${SITE}/works/${WARNED_B}/chapters/1`);
    await page.waitForURL(new RegExp(`/works/${WARNED_B}/warnings\\?next=`));
    await page.getByLabel("Don't show this screen again").check();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Continue" }).click(),
    ]);
    await page.waitForURL(`${SITE}/works/${WARNED_B}/chapters/1`);

    const stored = await site.db
      .selectFrom("user")
      .select("warnings_off")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(stored.warnings_off).toBe(true);

    // Another warned work, never continued past: it reads straight through.
    await page.goto(`${SITE}/works/${WARNED_A}/chapters/1`);
    await page.waitForURL(`${SITE}/works/${WARNED_A}/chapters/1`);
    expect(await mainText(page)).toContain(`pw3 warned ${WARNED_A} chapter 1`);
  });

  it("Reader settings apply without a reload and survive one", async () => {
    const { site } = running;
    const context = await site.newContext();
    const page = await context.newPage();
    await page.goto(`${SITE}/works/${SETTINGS}/chapters/1`);

    // Hidden until the nonced script has run under the CSP, so this shows the script ran.
    const theme = page.getByLabel("Theme");
    const size = page.getByLabel("Text size");
    await theme.waitFor();

    const before = await page.evaluate(() => ({
      origin: performance.timeOrigin,
      background: getComputedStyle(document.body).backgroundColor,
      fontSize: getComputedStyle(document.querySelector("article.chapter p")!).fontSize,
    }));
    await theme.selectOption("dark");
    await size.selectOption("xl");
    // No navigation: the same document, with its attributes set by the script.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          size: document.documentElement.dataset.size,
          origin: performance.timeOrigin,
          background: getComputedStyle(document.body).backgroundColor,
          fontSize: getComputedStyle(document.querySelector("article.chapter p")!).fontSize,
        })),
      )
      .toMatchObject({ theme: "dark", size: "xl", origin: before.origin });
    const live = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      fontSize: parseFloat(getComputedStyle(document.querySelector("article.chapter p")!).fontSize),
    }));
    expect(live.background).not.toBe(before.background);
    expect(live.fontSize).toBeGreaterThan(parseFloat(before.fontSize));

    await page.reload();
    expect(
      await page.evaluate(() => [
        document.documentElement.dataset.theme,
        document.documentElement.dataset.size,
      ]),
    ).toEqual(["dark", "xl"]);
    expect(await theme.inputValue()).toBe("dark");
    const cookie = (await context.cookies()).find((c) => c.name === "__Host-reader");
    expect(cookie).toMatchObject({ secure: true, path: "/" });
  });

  it("Reading position is saved while scrolling and Continue returns to it", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "pw3-position@example.test" });
    const page = await context.newPage();
    await page.goto(`${SITE}/works/${POSITION}/chapters/1`);

    const { room } = await scrollState(page);
    expect(room).toBeGreaterThan(1000);
    // The script saves 5 seconds after the last scroll; wait for the response, never sleep.
    await saveHalfway(page, POSITION, room);
    const { y } = await scrollState(page);
    const pct = Math.round((y / room) * 100);

    await page.goto(`${SITE}/works/${POSITION}`);
    const href = await page.locator("p.continue a").getAttribute("href");
    const [, shown] = /^\/works\/\d+\/chapters\/1#pos=(\d+)$/.exec(href ?? "") ?? [];
    expect(Math.abs(Number(shown) - pct)).toBeLessThanOrEqual(1);

    // Assert before touching the page: the restore skips a page already scrolled.
    await Promise.all([page.waitForEvent("load"), page.locator("p.continue a").click()]);
    await expect.poll(async () => (await scrollState(page)).y).toBeGreaterThan(0);
    const after = await scrollState(page);
    expect(Math.abs(after.y - (after.room * Number(shown)) / 100)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => location.hash)).toBe("");
  });

  // #405: measured in Chromium, the 302 to the warnings screen keeps the Continue link's #pos=50
  // (the screen's URL ends in it), and the form's POST then answers 303 with a Location that has no
  // fragment, so the chapter opens at the top. It fails on the last assertion, not before. It goes
  // red when #405 is fixed; then make it a plain test. `it.fails` counts any thrown error, so an
  // earlier step breaking would also read as the known failure: the position journey above runs
  // the same save and Continue steps as a plain test.
  it.fails("Continue returns to the saved position through the warnings screen (known failure: #405)", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "pw3-position-warned@example.test" });
    const page = await context.newPage();
    await page.goto(`${SITE}/works/${WARNED_POSITION}/chapters/1`);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Continue" }).click(),
    ]);
    const { room } = await scrollState(page);
    await saveHalfway(page, WARNED_POSITION, room);

    // A new session: the screen comes back before the chapter.
    await page.goto(`${SITE}/works/${WARNED_POSITION}`);
    await context.clearCookies({ name: "__Host-warned" });
    await page.locator("p.continue a").click();
    await page.waitForURL(new RegExp(`/works/${WARNED_POSITION}/warnings\\?next=`));
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Continue" }).click(),
    ]);
    await page.waitForURL(`${SITE}/works/${WARNED_POSITION}/chapters/1`);
    // The position is back: the chapter opens part way down, not at the top.
    await expect
      .poll(async () => (await scrollState(page)).y, { timeout: 3000 })
      .toBeGreaterThan(0);
  });

  it("Hidden and removed works show their 451 and 410 pages", async () => {
    const { site } = running;
    const page = await (await site.newContext()).newPage();

    const hidden = await page.goto(`${SITE}/works/${HIDDEN}/chapters/1`);
    expect(hidden?.status()).toBe(451);
    const hiddenText = await mainText(page);
    expect(hiddenText).toContain("Temporarily hidden by a moderator");
    expect(hiddenText).not.toMatch(/pw3[- ]Hidden work|pw3 hidden/);

    const removed = await page.goto(`${SITE}/works/${REMOVED}`);
    expect(removed?.status()).toBe(410);
    const removedText = await mainText(page);
    expect(removedText).toContain("This work has been removed");
    expect(removedText).not.toMatch(/pw3[- ]Removed work|pw3 removed/);

    // Chromium logs a console error for each non-2xx navigation; those two lines only.
    await site.assertClean({ allow: [/status of 451/, /status of 410/] });
  });
});
