import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://rarepair.fans";
// SAFETY: the default export is the Worker under test, loaded from wrangler.jsonc's main.
const worker = (exports as any).default as Fetcher;

const fetchW = (input: string, init: RequestInit = {}) =>
  worker.fetch(new URL(input, BASE).toString(), { redirect: "manual", ...init });

// Later tickets add their pages (reader, admin) here.
const LEGAL = ["/about", "/terms", "/privacy"];
// Signed out, /upload redirects to sign in; its page needs a session (02-upload-handshake).
const APP_PAGES = ["/login", "/remove", ...LEGAL, "/no-such-page"];

const htmlOf = async (path: string) => (await fetchW(path)).text();

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

const stylesheetHref = (html: string) =>
  html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1] ?? null;

/** What sits inside the header's home link. */
const homeLinkOf = (html: string) =>
  html.match(/<header><a class="site-name" href="\/">([\s\S]*?)<\/a>/)?.[1] ?? "";

const iconHref = (html: string) => html.match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1] ?? "";

const stylesheetOf = async () => {
  const href = stylesheetHref(await htmlOf("/about"));
  const res = await fetchW(href ?? "/missing.css");
  expect(res.status).toBe(200);
  return res.text();
};

describe("20-site-chrome-and-legal", () => {
  it("Temporary banner on every page", async () => {
    for (const path of APP_PAGES) {
      const html = await htmlOf(path);
      const banners = html.match(/<[a-z]+ class="banner"[^>]*>[\s\S]*?<\/[a-z]+>/g) ?? [];
      expect(banners, path).toHaveLength(1);
      expect(banners[0]).toMatch(/unofficial/i);
      expect(banners[0]).toContain('<a href="/about">');
      expect(html.indexOf('class="banner"'), path).toBeLessThan(html.indexOf("<main"));
    }
  });

  it("No AO3 or OTW branding", async () => {
    const branding = /AO3|OTW|Archive of Our Own|Organization for Transformative Works/i;
    for (const path of APP_PAGES) {
      expect(await htmlOf(path), path).not.toMatch(branding);
    }
    expect(await stylesheetOf()).not.toMatch(branding);
  });

  it("About, terms and privacy pages", async () => {
    for (const path of LEGAL) {
      const res = await fetchW(path);
      const html = await res.text();
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(count(html, /<h1\b/g)).toBe(1);
      expect(html).not.toMatch(/<script/i);
      expect(html).toMatch(/Draft/);
    }
  });

  it("The terms and privacy pages say what the archive does", async () => {
    expect(await htmlOf("/terms")).toMatch(/removal|remove/i);
    const privacy = await htmlOf("/privacy");
    expect(privacy).toMatch(/wait list/i);
    expect(privacy).toMatch(/confirmation email/i);
    expect(privacy).toMatch(/wait list form/i);
    expect(privacy).toMatch(/user agent/i);
    expect(privacy).toMatch(/network address/i);
    expect(privacy).toMatch(/remoteip/i);
  });

  it("The privacy page says requester data is kept until the site closes", async () => {
    const privacy = await htmlOf("/privacy");
    expect(privacy).toMatch(/requests keep .*email address/i);
    expect(privacy).toMatch(/hashed form of your network address/i);
    expect(privacy).toMatch(/work or pseud/i);
    expect(privacy).toMatch(/until the site closes, and then delete it/i);
    expect(privacy).toMatch(/do not erase .* when you ask/i);
  });

  it("The privacy page says what a copyright notice keeps", async () => {
    const privacy = await htmlOf("/privacy");
    expect(privacy).toMatch(
      /copyright notices keep .*name, address, telephone number and email address/i,
    );
    expect(privacy).toMatch(/your signature/i);
    expect(privacy).toMatch(/moderators read them to act on the notice/i);
    expect(privacy).toMatch(/notice you email .* stays in that mailbox/i);
    expect(privacy).toMatch(/keep notices until the site closes, and then delete them/i);
    expect(privacy).toMatch(/do not erase them when you ask/i);
  });

  it("Footer links to removal", async () => {
    for (const path of APP_PAGES) {
      const html = await htmlOf(path);
      const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? "";
      expect(footer, path).toContain('<a href="/remove">Remove my work</a>');
    }
  });

  it("Not-found page", async () => {
    const res = await fetchW("/no-such-page");
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toMatch(/<form role="search" method="get" action="\/search">/);
    expect(html).toMatch(/<label for="q">[^<]+<\/label>\s*<input type="search" id="q" name="q"/);
    expect(html).toMatch(/<button type="submit">/);
    expect(html).toMatch(/<main[\s\S]*<a href="\/">[\s\S]*<\/main>/);
  });

  it("The logo is in the site header", async () => {
    // A cross-site post is refused before the session is read: the bare header.
    const refusal = await fetchW("/login", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(refusal.status).toBe(403);
    const pages = [
      ...(await Promise.all(APP_PAGES.map(async (path) => [path, await htmlOf(path)] as const))),
      ["a refusal before the session", await refusal.text()] as const,
    ];
    for (const [path, html] of pages) {
      const link = homeLinkOf(html);
      expect(link, path).toMatch(/✯[\s\S]*rarepair$/);
      expect(link.indexOf("✯"), path).toBeLessThan(link.indexOf("rarepair"));
    }
  });

  it("The logo isn't read out", async () => {
    for (const path of APP_PAGES) {
      const link = homeLinkOf(await htmlOf(path));
      const star = link.match(/<span[^>]*>✯<\/span>/)?.[0] ?? "";
      expect(star, path).toContain('aria-hidden="true"');
      // Outside the hidden span the link reads exactly "rarepair".
      expect(link.replace(star, "").trim(), path).toBe("rarepair");
    }
  });

  it("The tab shows the star", async () => {
    for (const path of APP_PAGES) {
      const html = await htmlOf(path);
      expect(count(html, /<link rel="icon"/g), path).toBe(1);
      expect(html, path).toMatch(
        /<link rel="icon" type="image\/svg\+xml" href="\/assets\/logo\.[0-9a-f]+\.svg">/,
      );
    }
    const page = await fetchW("/about");
    const res = await fetchW(iconHref(await page.text()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age/);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The page's CSP lets a same-origin image load.
    expect(page.headers.get("content-security-policy")).toMatch(/img-src 'self'[ ;]/);
  });

  it("The icon is our own drawing, with nothing to fetch or run", async () => {
    const svg = await (await fetchW(iconHref(await htmlOf("/about")))).text();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32"/);
    expect(svg).toContain("<path ");
    expect(svg).not.toMatch(/<text|<script|<image|href=|@font-face|font-family|url\(|<style/i);
  });

  it("The logo follows the site name's colour", async () => {
    const rule = (await stylesheetOf()).match(/\.logo\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/(^|[;\s])color\s*:/);
  });
});

describe("21-accessibility-and-no-js", () => {
  it("Skip link, landmarks and one h1 in the page chrome", async () => {
    for (const path of APP_PAGES) {
      const html = await htmlOf(path);
      expect(count(html, /<h1\b/g), path).toBe(1);
      expect(count(html, /<header\b/g), path).toBe(1);
      expect(count(html, /<main\b/g), path).toBe(1);
      expect(count(html, /<footer\b/g), path).toBe(1);
      expect(html).toContain('<main id="main">');
      const firstLink = html.match(/<a\b[^>]*>/)?.[0];
      expect(firstLink).toBe('<a class="skip" href="#main">');
    }
  });

  it("Focus rings always visible", async () => {
    const css = await stylesheetOf();
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:[^;}]*var\(--accent\)[^}]*outline-offset/);
    expect(css).toMatch(/\.skip:focus/);
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it("No web fonts", async () => {
    const css = await stylesheetOf();
    expect(css).not.toMatch(/@font-face|url\(/);
    expect(css).toContain('system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    expect(css).toContain('Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif');
    for (const path of APP_PAGES) {
      const html = await htmlOf(path);
      // The stylesheet, and the tab icon: nothing else is linked, no font among it.
      const links = html.match(/<link\b[^>]*>/g) ?? [];
      expect(
        links.map((l) => l.match(/rel="([^"]+)"/)?.[1]),
        path,
      ).toEqual(["stylesheet", "icon"]);
      expect(html).not.toMatch(/<style\b|style="/);
    }
  });

  it("Reduced motion respected", async () => {
    const css = await stylesheetOf();
    const block =
      css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\}\s*\}/)?.[0] ?? "";
    expect(block).toMatch(/scroll-behavior:\s*auto/);
    expect(block).toMatch(/animation:\s*none/);
    expect(block).toMatch(/transition:\s*none/);
    expect(css.replace(block, "")).not.toMatch(/scroll-behavior:\s*smooth/);
  });

  it("Interface type and rhythm", async () => {
    const css = await stylesheetOf();
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*16px/);
    expect(css).toMatch(/body\s*\{[^}]*line-height:\s*1\.45/);
    for (const px of [13, 16, 20, 25, 31, 39]) expect(css).toContain(`${px}px`);
    expect(css).toMatch(/--space:\s*4px/);
    expect(css).toMatch(/article\.chapter\s*\{[^}]*line-height:\s*1\.6[^}]*max-width:\s*66ch/);
    expect(css).toMatch(/border-(top|bottom):\s*1px solid/);
  });

  it("The stylesheet is served from the page's own origin, cached for good", async () => {
    const href = stylesheetHref(await htmlOf("/about"));
    expect(href).toMatch(/^\/assets\/site\.[0-9a-f]+\.css$/);
    const res = await fetchW(href ?? "");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/css/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await fetchW("/assets/site.0000.css")).status).toBe(404);
  });
});
