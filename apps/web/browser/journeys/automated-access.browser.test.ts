import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { hasSidewaysScroll } from "../harness/layout";
import { seedReadableWork } from "../harness/seed";
import { SITE } from "../harness/site";

// A person whose browser sends a listed user agent, and a reader on another site's page. What the
// Worker answers to each kind of client is apps/web/test/24-bots-refused. AO3 work IDs 8812430 to
// 8812439 are this file's. Text is synthetic.
const WORK = 8812430;
const TEXT = "BW-JOURNEY-MARKER";
const OTHER_SITE = "https://other-site.example/";
const REFUSAL = "Automated access to this site isn't allowed";

// What a refused load prints: the page's stylesheet and icon.
const REFUSED_LOAD = /Failed to load resource: the server responded with a status of 403/;

describe("automated access journey", () => {
  const running = useJourneySite();

  it("Refusal page explains itself", async () => {
    const { site } = running;
    const context = await site.newContext({
      userAgent: "Mozilla/5.0 (compatible; Instapaper/8.0)",
    });
    const page = await context.newPage();
    const home = await page.goto(`${SITE}/`);
    expect(home?.status()).toBe(403);
    expect(await page.locator("main").innerText()).toContain(REFUSAL);
    expect(await hasSidewaysScroll(page)).toBe(false);

    // Its links go on working, for a browser that has since changed; this one still gets the 403.
    const [about] = await Promise.all([
      page.waitForResponse((r) => r.request().isNavigationRequest()),
      page.waitForEvent("load"),
      page.locator("main").getByRole("link", { name: "read about this site" }).click(),
    ]);
    expect(new URL(about.url()).pathname).toBe("/about");
    expect(about.status()).toBe(403);
    await site.assertClean({ allow: [REFUSED_LOAD] });
  });

  it("Another site can't spend a reader's limits: a link the reader follows is served", async () => {
    const { site } = running;
    await seedReadableWork(site, {
      ao3WorkId: WORK,
      rating: "General Audiences",
      chapters: [{ html: `<p>${TEXT}</p>` }],
    });
    const chapter = `${SITE}/works/${WORK}/chapters/1`;
    const context = await site.newContext();
    await context.route(OTHER_SITE, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Another site</title><a href="${chapter}">Read it</a>`,
      }),
    );
    const page = await context.newPage();
    await page.goto(OTHER_SITE);

    // An embed can't be shown here: Chromium won't let a public page load from the harness's
    // loopback address. apps/web/test/24-bots-refused has those requests.
    const [followed] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().isNavigationRequest() && r.frame() === page.mainFrame(),
      ),
      page.waitForEvent("load"),
      page.getByRole("link", { name: "Read it" }).click(),
    ]);
    expect(followed.status()).toBe(200);
    expect(await page.locator("main").innerText()).toContain(TEXT);
  });
});
