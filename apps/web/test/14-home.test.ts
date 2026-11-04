import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, STRICT, withoutNonce } from "./helpers";

// Work IDs 32000-32999 and the "Home Test" tag names are this file's alone: one database
// serves every test file in the project, and the home page lists whatever any file seeded.
// Both of its lists are capped, so nothing here asserts the lists whole. Their order and
// caps are proved on the db seam (packages/db/test/queries.test.ts).
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(async () => {
  await db.destroy();
});

const FANDOM = "Home Test Fandom";
const GONE_FANDOM = "Home Test Gone Fandom";
const LIVE = 32001;
const HIDDEN = 32002;
const REMOVED = 32003;
const CAUSES = [32004, 32005] as const;
const FANDOM_ONLY_HIDDEN = 32010;

const fandom = (name: string) => [{ type: "fandom" as const, name }];

beforeAll(async () => {
  // More live works than any other file gives one fandom, so it stays among the ten.
  for (let i = 0; i < 30; i++) {
    await seedWork(db, {
      ao3WorkId: i === 0 ? LIVE : 32100 + i,
      title: `Home Test Live ${i}`,
      tags: fandom(FANDOM),
    });
  }
  await seedWork(db, {
    ao3WorkId: HIDDEN,
    title: "Home Test Hidden",
    status: "hidden",
    hiddenCause: "removal_request",
    tags: fandom(FANDOM),
  });
  await seedWork(db, {
    ao3WorkId: REMOVED,
    title: "Home Test Removed",
    status: "removed",
    tags: fandom(FANDOM),
  });
  await seedWork(db, {
    ao3WorkId: CAUSES[0],
    status: "hidden",
    hiddenCause: "reports",
    tags: fandom(FANDOM),
  });
  await seedWork(db, {
    ao3WorkId: CAUSES[1],
    status: "hidden",
    hiddenCause: "moderator",
    tags: fandom(FANDOM),
  });
  // The newest of all, so it is among the recent works however many other files seed.
  await seedWork(db, {
    ao3WorkId: FANDOM_ONLY_HIDDEN,
    status: "hidden",
    hiddenCause: "removal_request",
    tags: fandom(GONE_FANDOM),
  });
});

const home = async () => {
  const res = await fetchW("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  return { res, html: await res.text() };
};

/** Each card's inner HTML, in page order. */
const cardsOf = (html: string) =>
  html
    .split(/<li><article class="work-card">/)
    .slice(1)
    .map((card) => card.slice(0, card.indexOf("</article></li>")));

const cardOf = (html: string, ao3WorkId: number) =>
  cardsOf(html).find((card) => card.includes(`href="/works/${ao3WorkId}"`)) ?? "";

describe("14-browse-and-home", () => {
  it("Home page leads with search", async () => {
    const { res, html } = await home();

    const search = html.indexOf('role="search"');
    const popular = html.indexOf("Popular fandoms");
    const recent = html.indexOf("Recently added");
    expect(search).toBeGreaterThan(-1);
    expect(popular).toBeGreaterThan(search);
    expect(recent).toBeGreaterThan(popular);
    expect(html.indexOf('<li><article class="work-card">')).toBeGreaterThan(recent);

    const form = html.match(/<form role="search"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('action="/search"');
    expect(form).toContain('method="get"');
    expect(form).toMatch(/<label for="q">[^<]+<\/label>/);
    expect(form).toMatch(/<input type="search" id="q" name="q">/);

    // No script, no inline style, no wait list form or widget, and the strict policy.
    expect(html).not.toMatch(/<script|style=|cf-turnstile|wait list/i);
    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
  });

  it("Home page lists popular fandoms as links, and recently added works as cards", async () => {
    // Added just before the request, so no other file's seeds are likelier to push it out.
    await seedWork(db, { ao3WorkId: 32050, title: "Home Test Newest", tags: fandom(FANDOM) });
    const { html } = await home();

    const link = html.match(/<a href="(\/tags\/fandom\/[^"]*)">Home Test Fandom<\/a>/)?.[1];
    expect(link).toBeDefined();
    const listing = await fetchW(link ?? "/missing");
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain('href="/works/32001"');

    const card = cardOf(html, 32050);
    expect(card).toContain("Home Test Newest");
  });

  it("Hidden works are left out of listings and the home page", async () => {
    const { html } = await home();
    const hidden = [HIDDEN, REMOVED, ...CAUSES, FANDOM_ONLY_HIDDEN];

    for (const id of hidden) expect(html, String(id)).not.toContain(`/works/${id}"`);
    expect(html).not.toContain("Home Test Hidden");
    expect(html).not.toContain("Home Test Removed");
    // A fandom only hidden works use is not among the popular ones, nor is its spelling shown.
    expect(html).not.toContain(GONE_FANDOM);

    const listing = await (await fetchW("/tags/fandom/home%20test%20fandom")).text();
    expect(listing).toContain('href="/works/32001"');
    for (const id of hidden) expect(listing, String(id)).not.toContain(`/works/${id}"`);
  });
});
