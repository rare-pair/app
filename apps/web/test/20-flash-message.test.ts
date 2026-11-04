import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://rarepair.fans",
  "sec-fetch-site": "same-origin",
};

const CLEAR = "__Host-flash=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly";

/** A `Cookie` header from `Set-Cookie` values, as a browser would send them back. */
const cookieHeader = (setCookies: string[]) => setCookies.map((c) => c.split(";")[0]).join("; ");

/** Every flash notice on a page. */
const flashesOf = (html: string) => html.match(/<p class="flash" role="status">[^<]*<\/p>/g) ?? [];

describe("20-site-chrome-and-legal", () => {
  it("Flash message after a POST", async () => {
    // Reader settings is a form that POSTs and redirects, and needs no database.
    const saved = await fetchW("/settings/reader", {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({ theme: "dark", next: "/about" }),
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/about");
    const cookies = cookieHeader(saved.headers.getSetCookie());
    expect(cookies).toContain("__Host-flash=settings-saved");

    const page = await fetchW("/about", { headers: { cookie: cookies } });
    expect(page.status).toBe(200);
    const html = await page.text();
    // One line at the top: after the banner, before the page's heading.
    expect(flashesOf(html)).toEqual(['<p class="flash" role="status">Reader settings saved.</p>']);
    const at = html.indexOf('class="flash"');
    expect(at).toBeGreaterThan(html.indexOf('class="banner"'));
    expect(at).toBeLessThan(html.indexOf("<main"));
    // Shown once: the page clears it, and is never cached with it.
    expect(page.headers.getSetCookie()).toEqual([CLEAR]);
    expect(page.headers.get("cache-control")).toBe("no-store");
    // The settings still apply on the same page.
    expect(html).toMatch(/<html lang="en" data-theme="dark">/);

    // The browser has dropped the flash, so the next page shows none.
    const again = await fetchW("/about", { headers: { cookie: "__Host-reader=theme=dark" } });
    expect(flashesOf(await again.text())).toEqual([]);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("A forged flash shows nothing", async () => {
    for (const value of ["no-such-code", "<b>Signed in</b>", "%3Cscript%3E", "toString"]) {
      const res = await fetchW("/about", { headers: { cookie: `__Host-flash=${value}` } });
      const html = await res.text();
      expect(flashesOf(html), value).toEqual([]);
      expect(html, value).not.toContain('class="flash"');
      expect(html, value).not.toContain("Signed in");
    }
  });

  it("A flash waits for a page that can show it", async () => {
    const cookie = "__Host-flash=settings-saved";
    // Not found, and not HTML: neither shows nor clears it.
    const missing = await fetchW("/no-such-page", { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(flashesOf(await missing.text())).toEqual([]);
    expect(missing.headers.getSetCookie()).toEqual([]);
    const redirect = await fetchW("/waitlist", { headers: { cookie } });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.getSetCookie()).toEqual([]);
  });
});
