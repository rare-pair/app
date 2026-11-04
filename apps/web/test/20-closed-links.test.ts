import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Once the archive is open, the footer link and the not-found search form work as before.

describe("20-closed-links after launch", () => {
  it("The footer's Remove my work link is a plain link", async () => {
    const html = await (await fetchW("/about")).text();
    expect(html).toContain('<a href="/remove">Remove my work</a>');
    expect(html).not.toContain("aria-disabled");
  });

  it("The not-found page's search form is enabled", async () => {
    const res = await fetchW("/no-such-page");
    expect(res.status).toBe(404);
    const html = await res.text();
    const form = html.match(/<form[^>]*role="search"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('type="search"');
    expect(form).not.toMatch(/\bdisabled\b/);
  });
});
