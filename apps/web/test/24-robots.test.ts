import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chapterPageKey } from "../src/edge-cache";
import { fetchW, signIn } from "./helpers";

// Runs in the "open" project; 24-robots.prelaunch.test.ts repeats the cases with PRELAUNCH on.
// This file keeps to AO3 work ID 8812100.
const WORK = 8812100;
const TAG = "noindex, noarchive, noai, noimageai";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

beforeAll(async () => {
  const work = await seedWork(db, { ao3WorkId: WORK, chapters: 2 });
  await putFragments(env.BUCKET, work.fragments);
});

const textOf = async (path: string) => (await (await fetchW(path)).text()).replace(/<[^>]+>/g, " ");

describe("24-crawler-and-agent-blocking", () => {
  it("robots.txt keeps crawlers off the app", async () => {
    for (const init of [
      {},
      { headers: { "user-agent": "GPTBot/1.0", "signature-agent": "https://x.example" } },
    ]) {
      const res = await fetchW("/robots.txt", init);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      const body = await res.text();
      expect(body).toMatch(/^User-agent: \*\nDisallow: \/$/m);
      expect(body).toContain("Content-Signal: search=no, ai-input=no, ai-train=no");
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("robots.txt is served to an account that hasn't accepted the terms", async () => {
    const cookie = await signIn("robots-newcomer@example.test");
    const res = await fetchW("/robots.txt", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("Every response asks not to be indexed or used", async () => {
    await fetchW(`/works/${WORK}/chapters/1`);
    // The second request is answered from the edge cache's copy of the page.
    expect(await caches.default.match(chapterPageKey(WORK, 1))).toBeDefined();
    const login = await (await fetchW("/login")).text();
    const sheet = login.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    expect(sheet).toBeDefined();
    // SAFETY: each entry is a [path, RequestInit] pair, listed here.
    for (const [path, init] of [
      ["/", {}],
      ["/about", {}],
      ["/terms", {}],
      ["/privacy", {}],
      ["/login", {}],
      [`/works/${WORK}`, {}],
      [`/works/${WORK}/chapters/1`, {}],
      [`/works/${WORK}/chapters/1`, {}],
      [`/works/${WORK}/full`, {}],
      [sheet!, {}],
      ["/robots.txt", {}],
      ["/no/such/page", {}],
      ["/logout", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }],
      ["https://www.rarepair.fans/about", {}],
    ] as [string, RequestInit][]) {
      const res = await fetchW(path, init);
      expect(res.headers.get("x-robots-tag"), `${path} ${res.status}`).toBe(TAG);
    }
    const www = await fetchW("https://www.rarepair.fans/about");
    expect(www.status).toBe(308);
    expect(www.headers.get("strict-transport-security")).toBeTruthy();
  });

  it("Terms forbid automated collection", async () => {
    const text = await textOf("/terms");
    expect(text).toMatch(/automated access to the site/i);
    expect(text).toMatch(/automated collection of fic text/i);
    expect(text).toMatch(/train AI models/i);
    expect(text).toMatch(/everyone who uses the site, not only people with an account/i);
  });

  it("Privacy page names Cloudflare's cookies", async () => {
    const text = await textOf("/privacy");
    expect(text).toContain("__cf_bm");
    expect(text).toMatch(/Cloudflare's bot protection may set its own cookie/);
    expect(text).toMatch(/real visitors from automated traffic/);
  });
});
