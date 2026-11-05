import type { BrowserContext, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { sendFiles, useJourneySite } from "../harness/journey";
import { seedReadableWork } from "../harness/seed";
import { signedIn, signedInDirect } from "../harness/sessions";
import { SITE, type Site } from "../harness/site";
import { byAddress, startAtHome, viaFooter, viaHeader, viaSearch } from "../harness/walk";
import { generatedEpub } from "./epubs";

// The helpers a journey walks with (harness/walk.ts, sessions.ts, journey.ts): they reach pages
// by the links a person clicks. Works here take AO3 ids 43310, 43311 and 43600; addresses are
// synthetic.

describe("walking helpers", () => {
  const running = useJourneySite();

  /**
   * The documents `page` (or every page `context` opens) is asked for, in order, with how each
   * was started: a `goto` carries no `Referer`, and a click on a link or a button on a page does.
   */
  const navigations = (watched: Page | BrowserContext) => {
    const asked: (readonly [string, "address" | "click"])[] = [];
    const watch = (page: Page) =>
      page.on("request", (request) => {
        if (request.isNavigationRequest()) {
          // The `Referer` is the page the click was on: only a request that came from a page has one.
          const started = "referer" in request.headers() ? "click" : "address";
          asked.push([new URL(request.url()).pathname, started] as const);
        }
      });
    if ("newPage" in watched) watched.on("page", watch);
    else watch(watched);
    return () => asked;
  };

  it("sendFiles from a blank page opens home, clicks Add work and sends the file", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "jh-send@example.test", role: "uploader" });
    const page = await context.newPage();
    const asked = navigations(page);
    const file = { name: "one.epub", bytes: generatedEpub({ workId: 43310 }) };
    await sendFiles(page, [file]);
    await page.locator("#files li").first().waitFor();
    // Home is opened by address (a blank page has nowhere to click from); /upload is a click.
    expect(asked().slice(0, 2)).toEqual([
      ["/", "address"],
      ["/upload", "click"],
    ]);
  });

  it("sendFiles from a page on the site clicks Add work there, without a visit to home", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "jh-here@example.test", role: "uploader" });
    const page = await startAtHome(context);
    await page.getByRole("link", { name: "About this site" }).click();
    await page.waitForURL(`${SITE}/about`);
    const asked = navigations(page);
    await sendFiles(page, [{ name: "two.epub", bytes: generatedEpub({ workId: 43311 }) }]);
    await page.locator("#files li").first().waitFor();
    // From /about, Add work is one click away: the next document is /upload, by that click and
    // not by an address (a goto to the same path would say "address").
    expect(asked().slice(0, 1)).toEqual([["/upload", "click"]]);
  });

  it("viaSearch finds a live work by its title and returns the work page's response", async () => {
    const { site } = running;
    await seedReadableWork(site, { ao3WorkId: 43600, title: "Jhsearch Lanternfield" });
    const page = await (await site.newContext()).newPage();
    const asked = navigations(page);
    const res = await viaSearch(page, "Jhsearch Lanternfield");
    expect(res.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/works/43600");
    // Home by address, the rest by clicks: Search, the form's GET, then the result.
    expect(asked().map(([path, started]) => `${path} ${started}`)).toEqual([
      "/ address",
      "/search click",
      "/search click",
      "/works/43600 click",
    ]);
  });

  it("viaHeader and viaFooter click the link in the header or the footer", async () => {
    const { site } = running;
    const page = await startAtHome(await site.newContext());
    await viaFooter(page, "Terms");
    expect(new URL(page.url()).pathname).toBe("/terms");
    await viaHeader(page, "Sign in");
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  it("viaHeader from a blank page begins at home", async () => {
    const page = await (await running.site.newContext()).newPage();
    await viaHeader(page, "Sign in");
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  it("byAddress opens the address, and refuses to without a reason", async () => {
    const page = await (await running.site.newContext()).newPage();
    await byAddress(page, "/about", "a link in a newsletter");
    expect(new URL(page.url()).pathname).toBe("/about");
    await expect(byAddress(page, "/terms", " ")).rejects.toThrow("needs the reason");
    expect(new URL(page.url()).pathname).toBe("/about");
  });

  describe("signing in", () => {
    /**
     * `site` with every context it opens watched, so the pages a sign-in opens inside the
     * helper (and closes before it returns) are seen. Every other member is the site's own.
     */
    const watching = (site: Site, asked: ReturnType<typeof navigations>[]): Site => ({
      ...site,
      newContext: async (options) => {
        const context = await site.newContext(options);
        asked.push(navigations(context));
        return context;
      },
    });

    it("signedIn walks from home to the sign-in page by a click", async () => {
      const { site } = running;
      const asked: ReturnType<typeof navigations>[] = [];
      const { context } = await signedIn(watching(site, asked), {
        email: "jh-walked@example.test",
      });
      // Home by address, then the header's Sign in by a click: never /login typed.
      expect(asked[0]?.()?.slice(0, 2)).toEqual([
        ["/", "address"],
        ["/login", "click"],
      ]);
      // And the account is signed in: the header it gets on home has My uploads.
      const page = await startAtHome(context);
      await page.getByRole("banner").getByRole("link", { name: "My uploads" }).waitFor();
    });

    it("signedInDirect opens the sign-in page by its address, without a visit to home", async () => {
      const { site } = running;
      const asked: ReturnType<typeof navigations>[] = [];
      const { context } = await signedInDirect(watching(site, asked), {
        email: "jh-direct@example.test",
      });
      expect(asked[0]?.()?.[0]).toEqual(["/login", "address"]);
      const page = await startAtHome(context);
      await page.getByRole("banner").getByRole("link", { name: "My uploads" }).waitFor();
    });
  });
});
