import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, headerOf, signIn } from "./helpers";

// Before launch (the "prelaunch" project, wrangler.jsonc as it deploys): /upload and
// /me/uploads are closed, so the header's Add work and My uploads show disabled as the
// footer's Remove link does. Sign in, Sign out and Admin stay live. Addresses are synthetic.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** The header's anchors, as [text, attributes]. */
const anchorsOf = (html: string) =>
  [...headerOf(html).matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].flatMap((m) =>
    m[2] === "rarepair" ? [] : [[m[2]!, m[1]!] as const],
  );

/** The anchor with `text`: its attributes. */
const anchor = (html: string, text: string) => anchorsOf(html).find(([t]) => t === text)?.[1];

const expectDisabled = (attrs: string | undefined, label: string) => {
  expect(attrs, label).toBeDefined();
  expect(attrs, label).toContain('aria-disabled="true"');
  expect(attrs, label).toContain('role="link"');
  expect(attrs, label).not.toContain("href");
};

describe("20-site-chrome-and-legal: the site header before launch", () => {
  it("Signed out, Add work is disabled and Sign in is live", async () => {
    for (const path of ["/", "/login", "/about", "/terms", "/privacy", "/waitlist"]) {
      const res = await fetchW(path);
      const html = await res.text();
      expectDisabled(anchor(html, "Add work"), path);
      expect(anchor(html, "Sign in"), path).toContain('href="/login"');
      expect(
        anchorsOf(html).map(([t]) => t),
        path,
      ).toEqual(["Add work", "Sign in"]);
      // The anonymous header has no form and no button: the wait list pages count theirs.
      expect(headerOf(html), path).not.toMatch(/<form|<button/);
    }
  });

  it("A moderator before launch has Admin and Sign out live, Add work and My uploads disabled", async () => {
    const email = "nav-prelaunch-mod@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    await db.updateTable("user").set({ role: "moderator" }).where("email", "=", email).execute();
    for (const path of ["/admin", "/logout", "/about"]) {
      const res = await fetchW(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expectDisabled(anchor(html, "Add work"), path);
      expectDisabled(anchor(html, "My uploads"), path);
      expect(anchor(html, "Admin"), path).toContain('href="/admin"');
      expect(anchor(html, "Sign in"), path).toBeUndefined();
      expect(headerOf(html), path).toContain('<form method="post" action="/logout">');
    }
  });

  it("A new account on the terms page has the header as ruled", async () => {
    const cookie = await signIn("nav-prelaunch-new@example.test");
    const res = await fetchW("/welcome/terms", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(headerOf(html)).toContain('action="/logout"');
    expectDisabled(anchor(html, "My uploads"), "terms page");
  });
});
