import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Before launch /remove and /search are closed, so the footer's "Remove my work" link
// and the not-found page's search form are shown disabled. Text is synthetic.

/** The footer's anchors, as [attributes, text] pairs. */
const footerLinks = (html: string) => {
  const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";
  return [...footer.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((m) => [m[1]!, m[2]!] as const);
};

describe("20-closed-links before launch", () => {
  it("Every app page's footer shows Remove my work as a disabled link", async () => {
    for (const path of ["/", "/about", "/terms", "/privacy", "/login"]) {
      const res = await fetchW(path);
      expect(res.status, path).toBe(200);
      const links = footerLinks(await res.text());
      // The footer's links to the two closed forms, /remove and /dmca.
      const closed = ["Remove my work", "Copyright notice"];
      const disabled = links.filter(([, text]) => closed.includes(text));
      expect(disabled, path).toHaveLength(2);
      for (const [attrs] of disabled) {
        expect(attrs, path).toContain('aria-disabled="true"');
        expect(attrs, path).not.toContain("href");
      }
      for (const [attrs, text] of links) {
        if (!closed.includes(text)) expect(attrs, `${path} ${text}`).toContain("href=");
      }
    }
  });

  it("The not-found page's search form shows with its input and button disabled", async () => {
    const res = await fetchW("/waitlist");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toMatch(/<label[^>]*for="q"/);
    const form = html.match(/<form[^>]*role="search"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toMatch(/<input\b[^>]*\bdisabled\b/);
    expect(form).toMatch(/<button\b[^>]*\bdisabled\b/);
  });

  it("No new open path: /remove and /search still redirect to the coming-soon page", async () => {
    for (const path of ["/remove", "/search?q=x"]) {
      const res = await fetchW(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/");
    }
  });

  it("Disabled controls look disabled, within the CSP", async () => {
    const res = await fetchW("/about");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("style-src 'self'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    const html = await res.text();
    expect(html).not.toMatch(/<[^>]+\sstyle=/);
    const href = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
    const css = await (await fetchW(href ?? "/missing.css")).text();
    expect(css).toContain('footer a[aria-disabled="true"]');
    expect(css).toContain('input[type="search"]:disabled');
    expect(css).toContain("cursor: not-allowed");
  });
});
