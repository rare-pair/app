import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, mailedWaitlistAddress, STRICT, withoutNonce } from "./helpers";

// PRELAUNCH turned on (wrangler.jsonc has it off). No work is seeded: a redirect never reads one.
// AO3 work ID 8812420 is this file's.
const W = 8812420;
const headers = { "user-agent": "GPTBot/1.3", "signature-agent": '"https://agent.example"' };

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

describe("24-crawler-and-agent-blocking", () => {
  it("Redirects still come first", async () => {
    const wwwUrl = `https://www.rarepair.fans/works/${W}/chapters/1?a=1`;
    const www = await fetchW(wwwUrl, { headers });
    expect(www.headers.get("location")).toBe((await fetchW(wwwUrl)).headers.get("location"));
    expect(www.status).toBe(308);
    expect(www.headers.get("location")).toBe(`https://rarepair.fans/works/${W}/chapters/1?a=1`);
    expect(await www.text()).toBe("");

    const closed = await fetchW(`/works/${W}/chapters/1`, { headers });
    expect(closed.status).toBe(302);
    expect(closed.headers.get("location")).toBe("/");
    const browser = await fetchW(`/works/${W}/chapters/1`);
    expect(closed.status).toBe(browser.status);
    expect(closed.headers.get("location")).toBe(browser.headers.get("location"));
    expect(await closed.text()).toBe("");
  });

  it("Redirects still come first: a page open before launch gets the 403", async () => {
    for (const path of ["/", "/about"]) {
      const res = await fetchW(path, { headers });
      expect(res.status, path).toBe(403);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      // Strict, on the coming-soon page's path too: the refusal has no Turnstile to frame.
      expect(withoutNonce(res.headers.get("content-security-policy")), path).toBe(STRICT);
      const html = await res.text();
      expect(html, path).toContain("Automated access to this site isn't allowed");
      expect(html, path).not.toContain("challenges.cloudflare.com");
    }
  });

  it("The refusal's links to closed pages are shown disabled", async () => {
    const html = await (await fetchW("/", { headers })).text();
    expect(html).not.toContain('href="/remove"');
    expect(html).not.toContain('href="/dmca"');
    expect(html).toContain('<a href="/about">');
  });

  it("Exempt paths are still served", async () => {
    expect((await fetchW("/robots.txt", { headers })).status).toBe(200);

    const { token, rows } = await mailedWaitlistAddress(db);
    const res = await fetchW(`/waitlist/unsubscribe?token=${token}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await rows()).toBe(0);
  });
});
