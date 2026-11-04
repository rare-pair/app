import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, headerOf, signIn } from "./helpers";

// Spec 20, the header's Search link, after launch. Before launch it is disabled
// (20-site-header.prelaunch). Addresses are synthetic, at @example.test.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

async function cookieFor(email: string, role: string | null = null): Promise<string> {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role }).where("email", "=", email).execute();
  return cookie;
}

describe("20-site-chrome-and-legal: the site header's Search link", () => {
  it("Search is the first link for every visitor and goes to /search", async () => {
    const user = await cookieFor("nav2-search-user@example.test");
    const moderator = await cookieFor("nav2-search-mod@example.test", "moderator");
    const visitors: Record<string, string>[] = [{}, { cookie: user }, { cookie: moderator }];
    for (const headers of visitors) {
      const html = await (await fetchW("/about", { headers })).text();
      const first = headerOf(html).match(
        /<nav aria-label="Site">\s*<a href="([^"]*)">([^<]*)<\/a>/,
      );
      expect(first?.slice(1)).toEqual(["/search", "Search"]);
    }
  });

  it("Search with no query is a page with the search box and no results", async () => {
    const res = await fetchW("/search");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form role="search" method="get" action="/search">');
    expect(html).toContain('<label for="q">Search the archive</label>');
    expect(html).toContain('<input type="search" id="q" name="q" value="">');
    expect(html).not.toMatch(/class="work-card|<ol/);
  });
});
