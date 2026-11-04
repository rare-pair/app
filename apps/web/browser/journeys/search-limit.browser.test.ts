import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { overSearchLimit } from "../harness/pages";
import { SITE } from "../harness/site";

describe("search limit journey", () => {
  const running = useJourneySite();

  it("A search over the limit shows the 429 page and says when to try again", async () => {
    const { site } = running;
    // The address's budget is spent from Node, so the browser's search is the one refused.
    const context = await site.newContext(await overSearchLimit(site));
    const page = await context.newPage();
    const response = await page.goto(`${SITE}/search?q=pw4`);

    expect(response?.status()).toBe(429);
    expect(response?.headers()["retry-after"]).toBe("60");
    expect(response?.headers()["cache-control"]).toBe("no-store");
    expect(response?.headers()["referrer-policy"]).toBe("strict-origin");
    expect(await page.locator("h1").innerText()).toBe("Too many requests");
    expect(await page.locator("main").innerText()).toContain("Please try again in 60 seconds.");

    // Chromium logs a refused page load as a console error; this is the one expected.
    await site.assertClean({ allow: [/status of 429/] });
  });
});
