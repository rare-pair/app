import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// With PRELAUNCH on (wrangler.jsonc as deployed). The rest is in 24-robots.test.ts.

describe("24-crawler-and-agent-blocking", () => {
  it("robots.txt keeps crawlers off the app", async () => {
    const res = await fetchW("/robots.txt", { headers: { "user-agent": "GPTBot/1.0" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toMatch(/^User-agent: \*\nDisallow: \/$/m);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("Every response asks not to be indexed or used", async () => {
    // A closed page redirects before launch; the redirect carries the header too.
    for (const [path, status] of [
      ["/", 200],
      ["/privacy", 200],
      ["/terms", 200],
      ["/works/1", 302],
      ["/search", 302],
      ["/robots.txt", 200],
    ] as const) {
      const res = await fetchW(path);
      expect(res.status, path).toBe(status);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, noarchive, noai, noimageai");
    }
  });

  it("Privacy page names Cloudflare's cookies", async () => {
    expect(await (await fetchW("/privacy")).text()).toContain("__cf_bm");
  });

  it("Terms forbid automated collection", async () => {
    expect(await (await fetchW("/terms")).text()).toMatch(/not only people with an account/);
  });
});
