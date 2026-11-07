import { describe, expect, it } from "vitest";
import { nonceOf } from "./helpers";
import { attr, expectInOrder, forms, NoJsBrowser, scriptTags, type Page } from "./no-js-browser";

// Runs in the "prelaunch" project: wrangler.jsonc with PRELAUNCH turned on. The wait
// list pages are in FRONTEND-DISCOVERY's inventory though spec 21's setup list omits them.
// They read the database for nothing here: every token is one no row holds. Text is synthetic.

// 43 base64url characters, as issued; no row holds it.
const TOKEN = "nojs".padEnd(43, "x");

const PAGES: { name: string; path: string; status?: number; after: string[] }[] = [
  {
    name: "coming soon",
    path: "/",
    // The message and the form it explains come in reading order.
    after: ["rarepair is coming soon", '<form class="waitlist"', "<noscript>", 'class="note"'],
  },
  { name: "confirm wait list", path: `/waitlist/confirm?token=${TOKEN}`, after: ["<form"] },
  { name: "unsubscribe", path: `/waitlist/unsubscribe?token=${TOKEN}`, after: ["<form"] },
  { name: "refused confirm link", path: "/waitlist/confirm?token=short", status: 400, after: [] },
];

const CHROME = ['class="skip"', 'class="banner"', "<header>", '<main id="main">', "<h1"];

const open = async (path: string): Promise<Page> => new NoJsBrowser().go(path);

describe("21-accessibility-and-no-js (before launch)", () => {
  it("Wait list pages render with JavaScript off and only the wait list form needs it", async () => {
    for (const entry of PAGES) {
      const { res, html } = await open(entry.path);
      const where = entry.name;
      expect(res.status, where).toBe(entry.status ?? 200);
      expect(res.headers.get("content-type"), where).toMatch(/^text\/html/);
      expect(html.match(/<main\b/g), where).toHaveLength(1);
      expect(html.match(/<h1\b/g), where).toHaveLength(1);
      expect(/<a\b[^>]*>/.exec(html)?.[0], where).toBe('<a class="skip" href="#main">');
      if (entry.path === "/") {
        // The form can't be sent without a script: the message says so, and the button is off.
        expect(html, where).toMatch(
          /<noscript><p>[^<]*joining the wait list needs JavaScript[^<]*<\/p><\/noscript>/i,
        );
        expect(forms(html)[0]!.html, where).toMatch(/<button[^>]*\bdisabled\b/);
      } else {
        // The emailed links' pages are plain: a button that posts, and no script at all.
        expect(scriptTags(html), where).toEqual([]);
        expect(html, where).not.toMatch(/<noscript|cf-turnstile|challenges\.cloudflare\.com/);
        expect(
          forms(html).filter((f) => f.hidden),
          where,
        ).toEqual([]);
      }
    }
  });

  it("Scripts only enhance wait list pages that have no Turnstile check", async () => {
    for (const entry of PAGES) {
      const { res, html } = await open(entry.path);
      const nonce = nonceOf(res.headers.get("content-security-policy"));
      expect(nonce, entry.name).not.toBeNull();
      expect(html, entry.name).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      for (const tag of scriptTags(html)) expect(attr(tag, "nonce"), entry.name).toBe(nonce);
      if (entry.path !== "/") expect(scriptTags(html), entry.name).toHaveLength(0);
    }
  });

  it("Wait list pages make sense with CSS off", async () => {
    for (const entry of PAGES) {
      const { html } = await open(entry.path);
      expectInOrder(html, [...CHROME, ...entry.after], entry.name);
      expect(html.indexOf("</main>"), entry.name).toBeLessThan(html.indexOf("<footer>"));
      expect(html, entry.name).not.toMatch(/<style\b|\sstyle\s*=/i);
    }
  });
});
