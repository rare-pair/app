import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://rarepair.fans";
// SAFETY: the default export is the Worker under test, loaded from wrangler.jsonc's main.
const worker = (exports as any).default as Fetcher;

const fetchW = (input: string, init: RequestInit = {}) =>
  worker.fetch(new URL(input, BASE).toString(), { redirect: "manual", ...init });

// The policies from the scenario's THEN lines, with the nonce left as {n}.
const STRICT =
  "default-src 'self'; script-src 'nonce-{n}' 'strict-dynamic'; style-src 'self'; img-src 'self' https://content.rarepair.fans; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TURNSTILE = `${STRICT}; frame-src https://challenges.cloudflare.com`;

/** The nonce in a CSP header, or null when there is none. */
const nonceOf = (csp: string | null) => csp?.match(/'nonce-([^']*)'/)?.[1] ?? null;

/** The header with its nonce swapped back to {n}, for whole-string comparison. */
const withoutNonce = (csp: string | null) => csp?.replace(/'nonce-[^']*'/, "'nonce-{n}'") ?? null;

describe("11-reader-and-csp", () => {
  it("Every app page sends the strict CSP", async () => {
    // No reader page exists yet, so the not-found page stands in for "any page".
    for (const path of ["/", "/no-such-page", "/login/confirm?token=x"]) {
      const res = await fetchW(path);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
    }
  });

  it("Turnstile pages allow only the Turnstile challenge frame", async () => {
    // Signed out, /upload redirects to sign in: 02-upload-handshake checks the signed-in page.
    for (const path of ["/login", "/remove", "/dmca"]) {
      const res = await fetchW(path);
      const csp = res.headers.get("content-security-policy");
      expect(res.status).toBe(200);
      expect(withoutNonce(csp)).toBe(TURNSTILE);

      const html = await res.text();
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      const apiJs = scripts.filter((tag) =>
        tag.includes('src="https://challenges.cloudflare.com/turnstile/v0/api.js"'),
      );
      expect(apiJs).toHaveLength(1);
      expect(apiJs[0]).toContain(`nonce="${nonceOf(csp)}"`);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonceOf(csp)}"`);
      expect(html).toContain("<noscript>");
    }

    // The allowance is keyed on the exact path, whatever the method.
    const post = await fetchW("/login", { method: "POST" });
    expect(withoutNonce(post.headers.get("content-security-policy"))).toBe(TURNSTILE);
    for (const path of ["/", "/login/confirm?token=x", "/loginx", "/upload/new"]) {
      const res = await fetchW(path);
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
    }
  });

  it("Nonce is fresh per response", async () => {
    // No chapter page exists yet; a Turnstile page also renders the nonce into its body.
    for (const path of ["/no-such-chapter", "/login"]) {
      const first = nonceOf((await fetchW(path)).headers.get("content-security-policy"));
      const second = nonceOf((await fetchW(path)).headers.get("content-security-policy"));
      // At least 128 bits of base64.
      expect(first).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
      expect(second).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
      expect(second).not.toBe(first);
    }
  });

  it("Every response requires HTTPS", async () => {
    const responses = [
      await fetchW("/login"), // a Turnstile page
      await fetchW("/no-such-page"), // an error page
      await fetchW("/", { method: "DELETE" }), // a method nothing routes
      await fetchW("https://www.rarepair.fans/login"), // a redirect
    ];
    for (const res of responses) {
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    }
  });

  it("Requests to www go to the bare domain", async () => {
    const cases: [string, string][] = [
      ["/works/1/chapters/2?x=1&y=2", "https://rarepair.fans/works/1/chapters/2?x=1&y=2"],
      ["/", "https://rarepair.fans/"],
      // A routed page: on www even it is redirected, never served.
      ["/login", "https://rarepair.fans/login"],
      ["/login?next=%2Fmy%20uploads", "https://rarepair.fans/login?next=%2Fmy%20uploads"],
      ["/caf%C3%A9", "https://rarepair.fans/caf%C3%A9"],
      // An empty query is still a query.
      ["/login?", "https://rarepair.fans/login?"],
    ];
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      for (const [path, location] of cases) {
        const init: RequestInit = { method };
        if (method === "POST" || method === "PUT") {
          init.headers = { "content-type": "application/x-www-form-urlencoded" };
          init.body = "email=reader%40example.test";
        }
        const res = await fetchW(`https://www.rarepair.fans${path}`, init);
        expect(res.status).toBe(308);
        expect(res.headers.get("location")).toBe(location);
        // Not otherwise handled: no page, cookie or form action on www.
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("content-security-policy")).toBeNull();
        expect(await res.text()).toBe("");
      }
    }

    // The fully qualified spellings are other origins to a browser: redirect them too.
    for (const host of ["www.rarepair.fans.", "rarepair.fans."]) {
      const res = await fetchW(`https://${host}/login?x=1`);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://rarepair.fans/login?x=1");
    }
  });

  it("Page cannot be framed", async () => {
    // Signed out, /upload is a redirect, with no page to frame.
    for (const path of ["/", "/login", "/remove"]) {
      const directives = (await fetchW(path)).headers.get("content-security-policy")?.split("; ");
      expect(directives).toContain("frame-ancestors 'none'");
    }
  });
});
