import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fragmentCacheKey } from "../src/edge-cache";
import { STRICT, fetchW, nonceOf, withoutNonce } from "./helpers";

// Every work here has an AO3 work ID in 25000-25099 and tags named r7-..., so no other
// test file sharing the database sees them. The Cache API keeps its entries from one
// test to the next (R2 writes are undone when a test ends; the cache is not), so each
// test seeds a work of its own and does every step inside itself.
const GENERAL = [{ type: "rating" as const, name: "General Audiences" }];

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

afterAll(() => db.destroy());

const chapterUrl = (id: number, n: number) => `/works/${id}/chapters/${n}`;

/** The markup between `<article class="chapter">` and its closing tag, or null. */
const articleOf = (html: string) =>
  html.match(/<article class="chapter">([\s\S]*)<\/article>/)?.[1] ?? null;

/**
 * Waits for the Worker's cache to hold `key`, put in a `waitUntil` that may outlast the
 * response. Fails if it hasn't in 5 seconds.
 */
async function kept(key: string) {
  const deadline = Date.now() + 5_000;
  while ((await caches.default.match(key)) === undefined) {
    if (Date.now() > deadline) throw new Error(`${key} not cached in 5 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every chapter article's markup, in page order. */
const articlesOf = (html: string) =>
  [...html.matchAll(/<article class="chapter">([\s\S]*?)<\/article>/g)].map(([, inner]) => inner);

/** Seeds a work with two chapters and puts its fragments in R2. */
async function seedTwoChapters(ao3WorkId: number, tags = GENERAL) {
  const w = await seedWork(db, {
    ao3WorkId,
    title: `R7 work ${ao3WorkId}`,
    tags,
    chapters: [{ html: `<p>R7-${ao3WorkId}-ONE</p>` }, { html: `<p>R7-${ao3WorkId}-TWO</p>` }],
  });
  await putFragments(env.BUCKET, w.fragments);
  return w;
}

/** Renames a work in the database, so a page built after it shows the new title. */
const rename = (ao3WorkId: number, title: string) =>
  db.updateTable("works").set({ title }).where("ao3_work_id", "=", ao3WorkId).execute();

/** Every `nonce="..."` value in a page's markup. */
const bodyNonces = (html: string) => [...html.matchAll(/nonce="([^"]*)"/g)].map(([, n]) => n);

describe("11 reader and CSP", () => {
  it("Fresh nonce on edge-cached pages for signed-out readers", async () => {
    await seedTwoChapters(25010);
    const url = chapterUrl(25010, 1);

    const first = await fetchW(url);
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    // Changed after the first read: a page from the edge cache still has the old title.
    await rename(25010, "R7 renamed 25010");
    const second = await fetchW(url);
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).toContain("R7 work 25010");
    expect(secondHtml).not.toContain("R7 renamed 25010");

    // Each response carries its own nonce, in its CSP and on every script it has.
    const n1 = nonceOf(first.headers.get("content-security-policy"));
    const n2 = nonceOf(second.headers.get("content-security-policy"));
    expect(n1).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(n2).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(n2).not.toBe(n1);
    expect(bodyNonces(firstHtml).length).toBeGreaterThan(0);
    expect(new Set(bodyNonces(firstHtml))).toEqual(new Set([n1]));
    expect(new Set(bodyNonces(secondHtml))).toEqual(new Set([n2]));
    expect(secondHtml).not.toContain(n1!);
    // Otherwise the same page, and the browser keeps neither.
    expect(secondHtml.replaceAll(n2!, "{n}")).toBe(firstHtml.replaceAll(n1!, "{n}"));
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(withoutNonce(second.headers.get("content-security-policy"))).toBe(STRICT);
  });

  it("Same fragment serves every reader", async () => {
    const w = await seedWork(db, {
      ao3WorkId: 25001,
      tags: GENERAL,
      chapters: [{ html: "<p>R7-SAME-ONE</p>" }, { html: "<p>R7-SAME-TWO</p>" }],
    });
    await putFragments(env.BUCKET, w.fragments);
    // Two readers with different settings, so neither page is edge-cached: only the
    // fragment can be shared.
    const dark = { cookie: "__Host-reader=theme=dark&size=xl&leading=relaxed" };
    const light = { cookie: "__Host-reader=theme=sepia&size=s&leading=compact&face=sans" };

    const first = await fetchW(chapterUrl(25001, 2), { headers: dark });
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(articleOf(firstHtml)).toBe("<p>R7-SAME-TWO</p>");

    // After the first read, the fragment comes from the Worker's cache, not R2.
    await env.BUCKET.delete(w.chapterKeys[1]!);
    const second = await fetchW(chapterUrl(25001, 2), { headers: light });
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(articleOf(secondHtml)).toBe(articleOf(firstHtml));
    // The two pages are dressed for their own readers.
    expect(firstHtml).toContain('data-theme="dark"');
    expect(secondHtml).toContain('data-theme="sepia"');
  });

  it("The entire work reads its fragments through the same cache", async () => {
    const w = await seedWork(db, {
      ao3WorkId: 25002,
      tags: GENERAL,
      chapters: [{ html: "<p>R7-FULL-ONE</p>" }, { html: "<p>R7-FULL-TWO</p>" }],
    });
    await putFragments(env.BUCKET, w.fragments);
    const full = `/works/25002/full`;

    const first = await fetchW(full);
    expect(first.status).toBe(200);
    expect(articlesOf(await first.text())).toEqual(["<p>R7-FULL-ONE</p>", "<p>R7-FULL-TWO</p>"]);

    // Both fragments were kept as the page streamed, in waitUntil; R2 is then no longer
    // needed for either.
    for (const n of [1, 2]) await kept(fragmentCacheKey(25002, n, w.versionId));
    for (const key of w.chapterKeys) await env.BUCKET.delete(key);
    const second = await fetchW(full);
    expect(second.status).toBe(200);
    expect(articlesOf(await second.text())).toEqual(["<p>R7-FULL-ONE</p>", "<p>R7-FULL-TWO</p>"]);
  });
});
