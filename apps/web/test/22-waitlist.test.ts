import { describe, expect, it } from "vitest";
import { fetchW, STRICT, withoutNonce } from "./helpers";

// Runs in the "open" project: wrangler.jsonc with PRELAUNCH "off", the archive open.

describe("22-waitlist", () => {
  it("After launch the archive takes over", async () => {
    // The home page has no wait list form, no Turnstile widget, and no redirect to a wait list.
    const home = await fetchW("/");
    expect(home.headers.get("location")).toBeNull();
    const html = await home.text();
    expect(html).not.toMatch(/action="\/waitlist"|cf-turnstile|wait list/i);
    expect(withoutNonce(home.headers.get("content-security-policy"))).toBe(STRICT);
  });

  it("With PRELAUNCH off, / gets no frame-src allowance and no page redirects", async () => {
    // / is the home page, with the strict policy only.
    const home = await fetchW("/");
    expect(home.status).toBe(200);
    expect(withoutNonce(home.headers.get("content-security-policy"))).toBe(STRICT);
    expect(await home.text()).not.toMatch(/cf-turnstile|wait list|woff2/i);

    // Pages that redirect before launch are served as they are.
    // Signed out, /upload goes to sign in, not to the coming-soon page.
    const upload = await fetchW("/upload");
    expect(upload.status).toBe(302);
    expect(upload.headers.get("location")).toBe("/login?next=%2Fupload");
    const pages: [string, number][] = [
      ["/remove", 200],
      ["/no-such-page", 404],
      ["/works/1/chapters/2", 404],
      ["/administrator", 404],
    ];
    for (const [path, status] of pages) {
      const res = await fetchW(path);
      expect(res.status, path).toBe(status);
      expect(res.headers.get("location")).toBeNull();
      // And none of them loads a web font.
      expect(await res.text()).not.toMatch(/\/assets\/waitlist\/|woff2|@font-face/);
    }
  });
});
