import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// The wait list's pages, which only the "prelaunch" project serves (#179). The rest of
// the pages are in 23-html-cache-control.test.ts.

describe("23-html-cache-control", () => {
  it("The coming-soon page is private and not stored", async () => {
    const res = await fetchW("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toContain("'nonce-");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("A page the wait list already sends no-store for keeps it", async () => {
    const res = await fetchW("/waitlist/confirm");
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
