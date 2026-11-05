import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Headless Chromium's dvh equals its vh, so the browser suite can't show the fallback: this
// does, from the stylesheet as the Worker serves it. No database, so no work ids.

describe("20-site-chrome-and-legal", () => {
  it("A short page fills the screen: the body's minimum height falls back to vh", async () => {
    const page = await fetchW("/about");
    const href = (await page.text()).match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
    const css = await (await fetchW(href ?? "/missing.css")).text();
    const body = css.match(/(?:^|\n)body \{([^}]*)\}/)?.[1] ?? "";
    // vh first, so a browser that knows dvh takes it, and one that doesn't keeps vh.
    expect(body.indexOf("min-height: 100vh;")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("min-height: 100dvh;")).toBeGreaterThan(body.indexOf("min-height: 100vh;"));
  });
});
