import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { STYLESHEET_PATH } from "../src/styles";
import { BASE, fetchW, nonceOf, TURNSTILE, withoutNonce } from "./helpers";

// Runs in the "prelaunch" project: wrangler.jsonc exactly as it deploys, PRELAUNCH on.

const TURNSTILE_API = "https://challenges.cloudflare.com/turnstile/v0/api.js";

const HSTS = "max-age=31536000; includeSubDomains";
const IMMUTABLE = "public, max-age=31536000, immutable";

// SHA-256 of the publishers' release files (apps/web/public/assets/waitlist/fonts/PROVENANCE.md).
const UPSTREAM_WOFF2 = {
  "Fraunces 1.000, Fonts - Web/Fraunces[SOFT,WONK,opsz,wght].woff2":
    "25e420d8c154303e08322ea77f08997c4aade75653ef18425772ada5abacd0ce",
  "@ibm/plex-mono 2.5.0, fonts/complete/woff2/IBMPlexMono-Regular.woff2":
    "ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350",
  "@ibm/plex-mono 2.5.0, fonts/complete/woff2/IBMPlexMono-Medium.woff2":
    "33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25",
};
const UPSTREAM_LICENCES = {
  "/assets/waitlist/fonts/fraunces/OFL.txt":
    "bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b",
  "/assets/waitlist/fonts/ibm-plex-mono/license.txt":
    "91c25c350d3cac39da2736d74f7ba37ef648f5237a4e330a240615bc8d8c4360",
};

/** Lowercase hex SHA-256 of some bytes. */
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Every opening tag of one element in some HTML. */
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];

describe("22-waitlist", () => {
  it("Coming-soon page shows the wait list form", async () => {
    const res = await fetchW("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const nonce = nonceOf(res.headers.get("content-security-policy"));
    const html = await res.text();

    expect(html).toMatch(/rarepair is coming soon/i);

    // An email address form, posted to /waitlist as a plain form.
    const forms = tags(html, "form");
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="post"');
    expect(forms[0]).toContain('action="/waitlist"');
    const inputs = tags(html, "input");
    const email = inputs.filter((tag) => tag.includes('name="email"'));
    expect(email).toHaveLength(1);
    expect(email[0]).toContain('type="email"');

    // Turnstile alongside: its widget, and its api.js carrying the page nonce.
    expect(html).toContain(`<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}"`);
    const scripts = tags(html, "script");
    const apiJs = scripts.filter((tag) => tag.includes(`src="${TURNSTILE_API}"`));
    expect(apiJs).toHaveLength(1);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);

    expect(html).toMatch(/one email when the archive opens, and nothing else/i);

    // It goes through the shared layout, temporary banner and footer included.
    expect(html).toContain('<aside class="banner"');
    expect(tags(html, "h1")).toHaveLength(1);
    expect(html).toContain('<a href="/privacy">Privacy</a>');
  });

  it("Coming-soon page without JavaScript explains the form needs it", async () => {
    // workerd runs no page script, so this reads the HTML a browser with JavaScript off gets.
    const html = await (await fetchW("/")).text();

    // The rest of the page renders: noscript wraps only its message.
    expect(html).toMatch(
      /<noscript><p>[^<]*joining the wait list needs JavaScript[^<]*<\/p><\/noscript>/i,
    );
    expect(html.replace(/<noscript>.*?<\/noscript>/s, "")).toMatch(/rarepair is coming soon/i);

    // Nothing can submit the form: its only submit button starts disabled, which also
    // blocks submitting by pressing Enter in the email field.
    const buttons = tags(html, "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatch(/\bdisabled\b/);
    expect(tags(html, "input").filter((tag) => /type="(submit|image)"/.test(tag))).toEqual([]);
  });

  it("Coming-soon page allows the Turnstile frame and nothing more", async () => {
    const requests: [string, string][] = [
      ["/", "GET"],
      ["/", "HEAD"],
      ["/?ref=1", "GET"],
    ];
    for (const [path, method] of requests) {
      const res = await fetchW(path, { method });
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(TURNSTILE);
    }
  });

  it("Coming-soon page serves its own fonts", async () => {
    const html = await (await fetchW("/")).text();

    // Two same-origin stylesheets: the site's, then the wait list's with the fonts.
    const sheets = tags(html, "link")
      .filter((tag) => tag.includes('rel="stylesheet"'))
      .map((tag) => tag.match(/href="([^"]+)"/)?.[1] ?? "");
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toBe(STYLESHEET_PATH);
    const cssPath = sheets[1] ?? "";
    expect(cssPath).toMatch(/^\/assets\/waitlist\//);
    const cssRes = await fetchW(cssPath);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toMatch(/^text\/css/);
    expect(cssRes.headers.get("cache-control")).toBe(IMMUTABLE);
    const cssBytes = new Uint8Array(await cssRes.arrayBuffer());
    expect(cssPath).toContain(`.${(await sha256(cssBytes)).slice(0, 16)}.css`);
    const css = new TextDecoder().decode(cssBytes);

    // Each family as woff2 from rarepair.fans, swapped in when it loads.
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    const families = faces.map((face) => face.match(/font-family:\s*"([^"]+)"/)?.[1]);
    expect(new Set(families)).toEqual(new Set(["Fraunces", "IBM Plex Mono"]));
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).toMatch(/src:\s*url\("\/assets\/[^"]+\.woff2"\)\s*format\("woff2"\)/);
    }

    // Headings and text in Fraunces, labels and buttons in IBM Plex Mono.
    const rule = (selector: string) =>
      css.match(new RegExp(`(^|\\n)${selector}\\s*{([^}]*)}`))?.[2];
    expect(rule("body")).toMatch(/font-family:\s*"Fraunces"/);
    expect(rule("h1,\\s*h2")).toMatch(/font-family:\s*"Fraunces"/);
    expect(rule("\\.waitlist label,\\s*\\.waitlist button")).toMatch(
      /font-family:\s*"IBM Plex Mono"/,
    );

    // The publishers' own files, unmodified, at content-hashed immutable paths.
    const fonts = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1] ?? "");
    expect(fonts).toHaveLength(Object.keys(UPSTREAM_WOFF2).length);
    const served = new Set<string>();
    for (const path of fonts) {
      const res = await fetchW(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
      expect(res.headers.get("strict-transport-security")).toBe(HSTS);
      const digest = await sha256(new Uint8Array(await res.arrayBuffer()));
      expect(path).toContain(`.${digest.slice(0, 16)}.woff2`);
      served.add(digest);

      // A revalidation keeps the file immutable: a 304 carries the same Cache-Control.
      const etag = res.headers.get("etag") ?? "";
      expect(etag).not.toBe("");
      const again = await fetchW(path, { headers: { "if-none-match": etag } });
      expect(again.status).toBe(304);
      expect(again.headers.get("cache-control")).toBe(IMMUTABLE);
    }
    expect(served).toEqual(new Set(Object.values(UPSTREAM_WOFF2)));

    // Nothing from another host but Turnstile's api.js, in the page or either
    // stylesheet, and no inline style for the CSP to refuse.
    const siteCss = await (await fetchW(STYLESHEET_PATH)).text();
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1] ?? "");
    for (const sheet of [css, siteCss]) {
      refs.push(
        ...[...sheet.matchAll(/url\(\s*["']?([^"')]*)/g)].map((m) => m[1] ?? ""),
        ...[...sheet.matchAll(/@import\s+["']([^"']*)/g)].map((m) => m[1] ?? ""),
      );
    }
    // And only the wait list's sheet loads a web font.
    expect(siteCss).not.toMatch(/@font-face|woff2/);
    for (const ref of refs) {
      if (ref === TURNSTILE_API) continue;
      expect(new URL(ref, BASE).origin).toBe(BASE);
    }
    expect(html).not.toMatch(/<style\b|\sstyle=/i);

    // The fonts' OFL licence files, linked from the page and served from rarepair.fans.
    for (const [path, digest] of Object.entries(UPSTREAM_LICENCES)) {
      expect(html).toContain(`href="${path}"`);
      const res = await fetchW(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await sha256(new Uint8Array(await res.arrayBuffer()))).toBe(digest);
    }
    // The provenance note is for the repo, not the site.
    expect((await fetchW("/assets/waitlist/fonts/PROVENANCE.md")).status).toBe(404);

    // No other app page loads a web font. (WL2 and WL3 build the other wait list pages
    // on waitlistPage, which links the same stylesheet.)
    for (const path of ["/about", "/terms", "/privacy"]) {
      const other = await (await fetchW(path)).text();
      expect(other).not.toMatch(/\/assets\/waitlist\/|woff2|@font-face/);
    }
  });

  it("Other app pages are closed before launch", async () => {
    const closed: [string, string][] = [
      ["/works/1/chapters/2?x=1", "GET"],
      ["/no-such-page", "GET"],
      ["/upload", "GET"],
      ["/upload", "POST"],
      ["/remove", "GET"],
      ["/login", "GET"],
      ["/login", "POST"],
      ["/login/confirm?token=x", "GET"],
      ["/login/confirm", "POST"],
      // Exceptions match whole path segments, not prefixes of a name.
      ["/administrator", "GET"],
      ["/waitlistx", "GET"],
      ["/loginx", "GET"],
      ["/login/confirm/x", "GET"],
      ["/terms/", "GET"],
      ["/welcome", "GET"],
      // Spellings that must not slip past the allow-list or reach a closed route.
      ["/upload", "HEAD"],
      ["/upload", "OPTIONS"],
      ["/UPLOAD", "GET"],
      // In full: on its own, "//upload" is a URL whose host is "upload".
      [`${BASE}//upload`, "GET"],
      ["/%75pload", "GET"],
      ["/login/", "GET"],
      ["/assets/../upload", "GET"],
      // Nothing serves Better Auth's routes yet, so they stay closed before launch.
      ["/api/auth/get-session", "GET"],
      ["/api/auth/sign-in/magic-link", "POST"],
    ];
    for (const [path, method] of closed) {
      const res = await fetchW(path, { method });
      expect(res.status, `${method} ${path}`).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    }

    // The exceptions, and the paths the open pages need, are not redirected. Most of
    // these pages don't exist yet, so they may be 404: just never 302.
    const open: [string, string][] = [
      ["/", "GET"],
      ["/waitlist", "GET"],
      ["/waitlist", "POST"],
      ["/waitlist/confirm?token=x", "GET"],
      ["/terms", "GET"],
      ["/privacy", "GET"],
      ["/about", "GET"],
      // A session from before sign-in closed can still leave.
      ["/logout", "GET"],
      ["/logout", "POST"],
      ["/admin", "GET"],
      ["/admin/launch", "GET"],
      ["/robots.txt", "GET"],
      ["/favicon.ico", "GET"],
      ["/assets/waitlist/fonts/fraunces/OFL.txt", "GET"],
    ];
    for (const [path, method] of open) {
      const res = await fetchW(path, { method });
      expect(res.status, `${method} ${path}`).not.toBe(302);
      expect(res.headers.get("location")).toBeNull();
    }
    // The terms page is open too, for such a session. Signed out it sends the visitor to
    // sign in, as it always does, and that redirect ends at the coming-soon page.
    const terms = await fetchW("/welcome/terms");
    expect(terms.status).toBe(302);
    expect(terms.headers.get("location")).toBe("/login?next=%2Fwelcome%2Fterms");
    // The static pages and their shared stylesheet are served in full.
    for (const path of ["/about", "/terms", "/privacy", STYLESHEET_PATH]) {
      expect((await fetchW(path)).status, path).toBe(200);
    }

    // www is still sent to the bare domain first, whatever the path.
    const www = await fetchW("https://www.rarepair.fans/upload");
    expect(www.status).toBe(308);
    expect(www.headers.get("location")).toBe("https://rarepair.fans/upload");
  });

  it("A missing or misspelt PRELAUNCH keeps the archive closed", async () => {
    // wrangler.jsonc ships it on.
    expect(env.PRELAUNCH).toBe("on");
    // Only "off" opens the archive: the same handler, with the setting overridden.
    for (const PRELAUNCH of [undefined, "", "false", "OFF", "0"]) {
      const overridden = { ...env, PRELAUNCH };
      const upload = await app.fetch(
        new Request(`${BASE}/upload`),
        overridden,
        createExecutionContext(),
      );
      expect(upload.status, String(PRELAUNCH)).toBe(302);
      const home = await app.fetch(new Request(`${BASE}/`), overridden, createExecutionContext());
      expect(home.status).toBe(200);
      expect(withoutNonce(home.headers.get("content-security-policy"))).toBe(TURNSTILE);
      expect(await home.text()).toMatch(/rarepair is coming soon/i);
    }
  });
});
