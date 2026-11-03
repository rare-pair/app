import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRICT, fetchW, nonceOf, withoutNonce } from "./helpers";

// Every work here has an AO3 work ID in 22000-22099 and tags named r5-..., so no other
// test file sharing the database sees them.
const W = 22001;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const w = await seedWork(db, {
    ao3WorkId: W,
    title: "R5 work",
    tags: [{ type: "rating" as const, name: "r5-General Audiences" }],
    // Synthetic markers only: no fic text in tests.
    chapters: [{ html: "<p>R5-ONE-TEXT</p>" }, { html: "<p>R5-TWO-TEXT</p>" }],
  });
  await putFragments(env.BUCKET, w.fragments);
});

afterAll(() => db.destroy());

const CHAPTER = `/works/${W}/chapters/2`;
const FULL = `/works/${W}/full`;

/** A page, as a reader whose settings cookie holds `settings` sees it. */
const pageWith = async (path: string, settings?: string) =>
  (
    await fetchW(
      path,
      settings === undefined ? {} : { headers: { cookie: `__Host-reader=${settings}` } },
    )
  ).text();

/** The stylesheet a page links to. */
const stylesheetOf = async (html: string) => {
  const href = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
  const res = await fetchW(href ?? "/missing.css");
  expect(res.status).toBe(200);
  return res.text();
};

/** The declarations of every top-level rule whose selector list includes exactly `selector`. */
const rulesFor = (css: string, selector: string) =>
  [
    ...css.replaceAll(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<=^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g),
  ].flatMap(([, selectors = "", body = ""]) =>
    selectors.split(",").some((s) => s.trim() === selector) ? [body] : [],
  );

/** The headers a browser on rarepair.fans sends with a form post. */
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://rarepair.fans",
  "sec-fetch-site": "same-origin",
};

/** A `Cookie` header from `Set-Cookie` values, as a browser would send them back. */
const cookieHeader = (setCookies: string[]) => setCookies.map((c) => c.split(";")[0]).join("; ");

/** The settings form on a page: how it posts, its selects and its hidden fields. */
const settingsForm = (html: string) => {
  const [, attrs = "", inner = ""] =
    html.match(/<form\b([^>]*\baction="\/settings\/reader"[^>]*)>([\s\S]*?)<\/form>/) ?? [];
  const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
  const selects: Record<string, { values: string[]; selected: string | null }> = {};
  for (const [, name = "", options = ""] of inner.matchAll(
    /<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g,
  )) {
    const values = [...options.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1] ?? "");
    const selected = options.match(/<option value="([^"]*)" selected>/)?.[1] ?? null;
    selects[name] = { values, selected };
  }
  const fields: Record<string, string> = {};
  for (const [, name = "", value = ""] of inner.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  )) {
    fields[name] = value;
  }
  // Every select submits its selected option, or its first.
  for (const [name, s] of Object.entries(selects)) fields[name] = s.selected ?? s.values[0] ?? "";
  return {
    method: attr("method"),
    action: attr("action"),
    hidden: /\shidden\b/.test(attrs),
    selects,
    fields,
    hasSubmit: /<button type="submit"/.test(inner),
  };
};

/** The page's <html> start tag. */
const htmlTag = (html: string) => html.match(/<html\b[^>]*>/)?.[0] ?? null;

describe("13-reader-settings-and-position", () => {
  it("Settings come from a cookie as attributes on html", async () => {
    const html = await pageWith(CHAPTER, "theme=dark&size=l&leading=relaxed");
    expect(html).toContain("R5-TWO-TEXT");
    expect(htmlTag(html)).toBe(
      '<html lang="en" data-theme="dark" data-size="l" data-leading="relaxed">',
    );
    expect(html).not.toMatch(/\sstyle=|<style\b/i);
    // Values outside the lists give no attribute and are never echoed.
    const hostile = await pageWith(CHAPTER, 'theme="><script>x&size=xxl');
    expect(htmlTag(hostile)).toBe('<html lang="en">');
    expect(hostile).not.toContain("xxl");
    expect(hostile).not.toContain('"><script>x');
    // The entire work, which streams, gets them too.
    expect(htmlTag(await pageWith(FULL, "theme=dark&size=l&leading=relaxed"))).toBe(
      '<html lang="en" data-theme="dark" data-size="l" data-leading="relaxed">',
    );
  });

  it("Font sizes S, M, L and XL", async () => {
    const css = await stylesheetOf(await pageWith(CHAPTER));
    expect(rulesFor(css, "article.chapter").join("\n")).toMatch(
      /font-size:\s*var\(--reading-size\);/,
    );
    const sizes = { s: 16, m: 18, l: 20, xl: 23 };
    for (const [size, px] of Object.entries(sizes)) {
      expect(rulesFor(css, `html[data-size="${size}"]`).join("\n"), size).toMatch(
        new RegExp(`--reading-size:\\s*${px}px;`),
      );
      expect(htmlTag(await pageWith(CHAPTER, `size=${size}`))).toBe(
        `<html lang="en" data-size="${size}">`,
      );
    }
  });

  it("Default reading size is 18 px", async () => {
    const html = await pageWith(CHAPTER);
    expect(htmlTag(html)).toBe('<html lang="en">');
    const css = await stylesheetOf(html);
    expect(rulesFor(css, ":root").join("\n")).toMatch(/--reading-size:\s*18px;/);
  });

  it("Themes light, dark and sepia", async () => {
    const css = await stylesheetOf(await pageWith(CHAPTER));
    for (const theme of ["light", "dark", "sepia"]) {
      const rules = rulesFor(css, `:root[data-theme="${theme}"]`).join("\n");
      expect(rules, theme).toMatch(
        new RegExp(`color-scheme:\\s*${theme === "dark" ? "dark" : "light"};`),
      );
      expect(htmlTag(await pageWith(CHAPTER, `theme=${theme}`))).toBe(
        `<html lang="en" data-theme="${theme}">`,
      );
    }
    // Each theme that is not the default sets the page's colours.
    for (const theme of ["dark", "sepia"]) {
      const rules = rulesFor(css, `:root[data-theme="${theme}"]`).join("\n");
      for (const colour of ["--ink", "--paper", "--muted", "--rule", "--accent"]) {
        expect(rules, `${theme} ${colour}`).toMatch(new RegExp(`${colour}:\\s*#[0-9a-f]{6};`));
      }
    }
  });

  it("Default theme follows prefers-color-scheme", async () => {
    const html = await pageWith(CHAPTER);
    expect(htmlTag(html)).toBe('<html lang="en">');
    const css = await stylesheetOf(html);
    // The system's dark preference applies only while no theme is chosen, so an explicit
    // light or sepia choice wins over a dark system.
    const media =
      css.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?\})\s*\}/)?.[1] ?? "";
    expect(media).toMatch(/^\s*:root:not\(\[data-theme\]\)\s*\{[^}]*--paper:\s*#[0-9a-f]{6};/);
    expect(rulesFor(css, ":root").join("\n")).toMatch(/color-scheme:\s*light dark;/);
  });

  it("Serif or sans-serif reading face", async () => {
    const html = await pageWith(CHAPTER);
    expect(htmlTag(html)).toBe('<html lang="en">');
    const css = await stylesheetOf(html);
    expect(rulesFor(css, ":root").join("\n")).toContain(
      '--reading: Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif;',
    );
    expect(rulesFor(css, "article.chapter").join("\n")).toMatch(/font-family:\s*var\(--reading\);/);
    expect(rulesFor(css, 'html[data-face="sans"]').join("\n")).toMatch(/--reading:\s*var\(--ui\);/);
    expect(htmlTag(await pageWith(CHAPTER, "face=sans"))).toBe('<html lang="en" data-face="sans">');
  });

  it("Line spacing setting", async () => {
    const css = await stylesheetOf(await pageWith(CHAPTER));
    const leading = { compact: "1.45", normal: "1.6", relaxed: "1.8" };
    for (const [name, height] of Object.entries(leading)) {
      expect(
        rulesFor(css, `html[data-leading="${name}"] article.chapter`).join("\n"),
        name,
      ).toMatch(new RegExp(`line-height:\\s*${height.replace(".", "\\.")};`));
      expect(htmlTag(await pageWith(CHAPTER, `leading=${name}`))).toBe(
        `<html lang="en" data-leading="${name}">`,
      );
    }
  });

  it("Settings form works without JS", async () => {
    // The reader's settings link from the chapter carries the chapter as `next`.
    const settingsPath = `/settings/reader?next=${encodeURIComponent(CHAPTER)}`;
    const page = await fetchW(settingsPath, { headers: { cookie: "__Host-reader=size=l" } });
    expect(page.status).toBe(200);
    const form = settingsForm(await page.text());
    expect(form.method).toBe("post");
    expect(form.hidden).toBe(false);
    // A control for each of the four settings, the current value selected.
    expect(Object.keys(form.selects).sort()).toEqual(["face", "leading", "size", "theme"]);
    expect(form.selects.size?.selected).toBe("l");
    const themeField = Object.entries(form.selects).find(([, s]) => s.values.includes("sepia"));
    expect(themeField).toBeDefined();
    expect(form.fields.next).toBe(CHAPTER);
    expect(form.hasSubmit).toBe(true);

    // Submitted as a browser would, with only the theme changed.
    const res = await fetchW(form.action, {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: "__Host-reader=size=l" },
      body: new URLSearchParams({ ...form.fields, [themeField?.[0] ?? "theme"]: "sepia" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(CHAPTER);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain(
      "__Host-reader=theme=sepia&size=l&leading=normal&face=serif; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
    );
    expect(cookies).toContain(
      "__Host-flash=settings-saved; Max-Age=60; Path=/; SameSite=Lax; Secure; HttpOnly",
    );

    // Back on the chapter, with the cookie the browser now holds.
    const back = await fetchW(CHAPTER, { headers: { cookie: cookieHeader(cookies) } });
    expect(htmlTag(await back.text())).toMatch(/^<html lang="en" data-theme="sepia" /);
  });

  it("Settings form refuses cross-site posts and off-site redirects", async () => {
    const post = (headers: Record<string, string>, body: string) =>
      fetchW("/settings/reader", { method: "POST", headers, body });
    const body = new URLSearchParams({ theme: "dark", next: CHAPTER }).toString();
    for (const headers of [
      { ...FORM_HEADERS, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { "content-type": FORM_HEADERS["content-type"] },
    ]) {
      const res = await post(headers, body);
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    for (const next of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
      const res = await post(FORM_HEADERS, new URLSearchParams({ theme: "dark", next }).toString());
      expect(res.status, next).toBe(303);
      expect(res.headers.get("location"), next).toBe("/settings/reader");
    }
    // A body too large to be the form sets nothing.
    const huge = await post(FORM_HEADERS, `theme=dark&next=/&pad=${"x".repeat(20_000)}`);
    expect(huge.headers.getSetCookie()).toEqual([]);
    expect(huge.status).toBe(413);
  });

  it("Invalid settings values are ignored and the rest kept", async () => {
    const res = await fetchW("/settings/reader", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: "__Host-reader=theme=dark&size=s" },
      body: new URLSearchParams({ theme: "neon", size: "xl", face: "<b>", next: "/about" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toContain(
      "__Host-reader=theme=dark&size=xl; Max-Age=31536000; Path=/; SameSite=Lax; Secure",
    );
  });

  it("Settings apply live with JS", async () => {
    // The browser half (the attribute flips, the cookie is written) runs the script's
    // source in reader-settings.node.test.ts, and in a browser is a live check. Here:
    // the chapter, the entire work and the settings page load the script with the page's
    // nonce, from a cached, hashed URL.
    let src = "";
    for (const path of [CHAPTER, FULL, "/settings/reader"]) {
      const res = await fetchW(path, { headers: { cookie: "__Host-reader=size=l" } });
      expect(res.status, path).toBe(200);
      const csp = res.headers.get("content-security-policy");
      expect(withoutNonce(csp), path).toBe(STRICT);
      const html = await res.text();
      const tag = html.match(/<script src="([^"]+)" nonce="([^"]+)" (defer|async)><\/script>/);
      expect(tag, path).not.toBeNull();
      // The entire work streams for a long time, and a deferred script would wait for all
      // of it: there the script comes straight after the bar and runs as soon as it loads.
      if (path === FULL) {
        expect(tag?.[3]).toBe("async");
        // After the whole bar, so its controls exist when the script runs.
        const at = html.indexOf(tag?.[0] ?? "");
        const form = html.indexOf('<form class="reader-settings"');
        expect(at).toBeGreaterThan(html.indexOf("</form>", form));
        expect(at).toBeLessThan(html.indexOf('<article class="chapter"'));
      } else {
        expect(tag?.[3]).toBe("defer");
      }
      expect(tag?.[1]).toMatch(/^\/assets\/reader-settings\.[0-9a-f]{8}\.js$/);
      expect(tag?.[2], path).toBe(nonceOf(csp));
      src = tag?.[1] ?? "";
      // The controls it changes: on the chapter, a form in the reader bar, hidden until the
      // script shows it and selects the reader's values, so the bar is the same for every
      // reader; on the settings page, the server selects them, for JS off.
      const form = settingsForm(html);
      const reading = path !== "/settings/reader";
      expect(form.selects.size?.selected, path).toBe(reading ? "m" : "l");
      expect(form.hidden, path).toBe(reading);
      // Saving from a reading page's bar comes back to that page.
      if (reading) expect(form.fields.next, path).toBe(path);
    }
    const script = await fetchW(src);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("set-cookie")).toBeNull();
    expect(await script.text()).toContain("document.cookie");
    // Only the current hash is served.
    expect((await fetchW("/assets/reader-settings.00000000.js")).status).toBe(404);
  });

  it("Saving with no page to return to stays on the settings page", async () => {
    // Opened directly, with no `next`: there is nowhere to go back to, so no Back link,
    // and saving comes back to the settings page rather than to a page that may not exist.
    const page = await (await fetchW("/settings/reader")).text();
    expect(settingsForm(page).fields.next).toBe("/settings/reader");
    expect(page).not.toContain(">Back</a>");
    for (const body of ["theme=dark", "theme=dark&next="]) {
      const res = await fetchW("/settings/reader", {
        method: "POST",
        headers: FORM_HEADERS,
        body: new URLSearchParams(body),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/settings/reader");
    }
  });

  it("Saving from the entire work comes back to it with the flash", async () => {
    const saved = await fetchW("/settings/reader", {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({ size: "xl", next: FULL }),
    });
    expect(saved.headers.get("location")).toBe(FULL);
    const res = await fetchW(FULL, {
      headers: { cookie: cookieHeader(saved.headers.getSetCookie()) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "__Host-flash=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly",
    ]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html.match(/<p class="flash" role="status">[^<]*<\/p>/g)).toEqual([
      '<p class="flash" role="status">Reader settings saved.</p>',
    ]);
    expect(htmlTag(html)).toBe('<html lang="en" data-size="xl">');
    expect(html).toContain("R5-TWO-TEXT");
  });

  it("Settings apply on error pages too", async () => {
    const res = await fetchW("/no-such-page", { headers: { cookie: "__Host-reader=theme=sepia" } });
    expect(res.status).toBe(404);
    expect(htmlTag(await res.text())).toBe('<html lang="en" data-theme="sepia">');
  });

  it("Reduced motion turns off smooth scrolling", async () => {
    // Nothing scrolls smoothly in the first place, and the reduced-motion block stays.
    // The settings script never scrolls (reader-settings.node.test.ts).
    const css = await stylesheetOf(await pageWith(CHAPTER, "size=xl&leading=relaxed"));
    expect(css).not.toMatch(/scroll-behavior:\s*smooth/);
    const block =
      css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\}\s*\}/)?.[0] ?? "";
    expect(block).toMatch(/scroll-behavior:\s*auto/);
  });

  it("Reading column measure", async () => {
    // The default spacing and measure hold beside the size rule; only a chosen spacing
    // changes the line height, and nothing changes the measure.
    const css = await stylesheetOf(await pageWith(CHAPTER));
    const chapter = rulesFor(css, "article.chapter").join("\n");
    expect(chapter).toMatch(/line-height:\s*1\.6;/);
    expect(chapter).toMatch(/max-width:\s*66ch;/);
    expect(chapter).toMatch(/font-size:\s*var\(--reading-size\);/);
    expect(css.match(/max-width:\s*66ch/g)?.length).toBe(2);
    expect(rulesFor(css, "header").join("\n") + rulesFor(css, "main").join("\n")).toMatch(
      /margin:\s*0 auto;/,
    );
  });

  it("Settings work for signed-out readers", async () => {
    // No session cookie at all: the page and the POST need none, and nothing sends the
    // reader to sign in.
    const page = await fetchW("/settings/reader");
    expect(page.status).toBe(200);
    const res = await fetchW("/settings/reader", {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams({ size: "xl", next: CHAPTER }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(CHAPTER);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-reader=size=xl;"))).toBe(true);
    const back = await fetchW(CHAPTER, { headers: { cookie: cookieHeader(cookies) } });
    expect(htmlTag(await back.text())).toBe('<html lang="en" data-size="xl">');
  });
});
