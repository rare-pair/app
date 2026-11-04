import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, signIn } from "./helpers";

// Every HTML page carries a fresh CSP nonce, so a shared cache that stored one would hand
// every visitor the same nonce (#179). A page without a Cache-Control of its own gets
// `private, no-store`, set beside the CSP; one that sets its own keeps it.
// Runs in the "open" project; the wait list pages are in 23-html-cache-control.prelaunch.test.ts.

// This file keeps to AO3 work ID 23001.
const WORK = 23001;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

beforeAll(async () => {
  const work = await seedWork(db, { ao3WorkId: WORK, chapters: 2 });
  await putFragments(env.BUCKET, work.fragments);
});

const DEFAULT = "private, no-store";

/** A page's Cache-Control, once it is known to be HTML. */
async function cacheControlOf(path: string, init: RequestInit = {}) {
  const res = await fetchW(path, init);
  expect(`${path} ${res.status} ${res.headers.get("content-type")}`).toMatch(/ \d+ text\/html/);
  expect(res.headers.get("content-security-policy"), path).toContain("'nonce-");
  return res.headers.get("cache-control");
}

describe("23-html-cache-control", () => {
  it("Pages without a Cache-Control of their own are private and not stored", async () => {
    for (const path of [
      "/login",
      "/remove",
      "/about",
      "/terms",
      "/privacy",
      `/works/${WORK}`,
      `/works/${WORK}/chapters/1`,
      `/works/${WORK}/full`,
    ]) {
      expect(await cacheControlOf(path), path).toBe(DEFAULT);
    }
  });

  it("Pages for a signed-in reader are private and not stored", async () => {
    const cookie = await signIn("html-cache@example.test", { acceptTerms: true });
    for (const path of ["/upload", "/settings/reader", `/works/${WORK}`, `/works/${WORK}/report`]) {
      const control = await cacheControlOf(path, { headers: { cookie } });
      expect(control, path).toMatch(/\b(private|no-store)\b/);
      expect(control, path).not.toMatch(/\bpublic\b/);
    }

    // Before the terms are accepted, the page that asks for them.
    const newcomer = await signIn("html-cache-terms@example.test");
    expect(await cacheControlOf("/welcome/terms", { headers: { cookie: newcomer } })).toMatch(
      /\bno-store\b/,
    );
  });

  it("A page's own Cache-Control is kept", async () => {
    // The tag listing's short private cache (#298).
    expect(await cacheControlOf("/tags/freeform/html-cache-never-seeded")).toBe(
      "private, max-age=60, stale-while-revalidate=60",
    );
    // The pages that already say no-store say it still: a 404 page, and the upload page.
    expect(await cacheControlOf("/no/such/page")).toBe("no-store");
    const cookie = await signIn("html-cache-own@example.test", { acceptTerms: true });
    expect(await cacheControlOf("/upload", { headers: { cookie } })).toBe("no-store");
  });

  it("A response that isn't HTML is left alone", async () => {
    const page = await (await fetchW("/login")).text();
    const sheet = page.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    expect(sheet).toBeDefined();
    const res = await fetchW(sheet!);
    expect(res.headers.get("content-type")).toMatch(/^text\/css/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
