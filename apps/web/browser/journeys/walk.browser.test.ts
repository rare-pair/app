import { describe, expect, it } from "vitest";
import { sendFiles, useJourneySite } from "../harness/journey";
import { signedIn, signedInDirect } from "../harness/sessions";
import { SITE } from "../harness/site";
import { byAddress, startAtHome, viaFooter, viaHeader } from "../harness/walk";
import { generatedEpub } from "./epubs";

// The helpers a journey walks with (harness/walk.ts, sessions.ts, journey.ts): they reach pages
// by the links a person clicks. Works here take AO3 id 43310; addresses are synthetic.

describe("walking helpers", () => {
  const running = useJourneySite();

  /** The addresses of the documents `page` is asked for, in order. */
  const navigations = (page: import("playwright").Page) => {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) asked.push(new URL(request.url()).pathname);
    });
    return asked;
  };

  it("sendFiles from a blank page opens home, clicks Add work and sends the file", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "jh-send@example.test", role: "uploader" });
    const page = await context.newPage();
    const asked = navigations(page);
    const file = { name: "one.epub", bytes: generatedEpub({ workId: 43310 }) };
    await sendFiles(page, [file]);
    await page.locator("#files li").first().waitFor();
    // SAFETY: the page was reached by the header's link: home first, then /upload, never typed.
    expect(asked.slice(0, 2)).toEqual(["/", "/upload"]);
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
    // SAFETY: from /about, Add work is one click away: the next document is /upload.
    expect(asked[0]).toBe("/upload");
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

  it("signedInDirect signs in without walking, signedIn walks from home", async () => {
    const { site } = running;
    for (const [email, signIn] of [
      ["jh-direct@example.test", signedInDirect],
      ["jh-walked@example.test", signedIn],
    ] as const) {
      const { context } = await signIn(site, { email });
      const page = await context.newPage();
      await page.goto(`${SITE}/me/uploads`);
      expect(new URL(page.url()).pathname).toBe("/me/uploads");
      await page.close();
    }
  });
});
