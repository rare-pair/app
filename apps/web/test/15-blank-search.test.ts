import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeHtml } from "../src/home";
import { allWorksHtml } from "../src/search";
import { fetchW, freshIp } from "./helpers";

// Work IDs 36000-36999 and the "All Works Web" tag names are this file's alone. One
// database serves every test file, so a blank `/search` also lists the others' works: these
// tests find their own by tag, and leave exact counts to packages/db's test.
const db = createDb({
  connectionString: env.HYPERDRIVE.connectionString,
  max: 1,
});
afterAll(async () => {
  await db.destroy();
});

const FANDOM = "All Works Web";
const NARROW = `tag=${encodeURIComponent(FANDOM)}&tag_type=fandom`;
const OURS = Array.from({ length: 21 }, (_, i) => 36000 + i);

const htmlOf = async (path: string) => {
  const res = await fetchW(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

/** Each card's inner HTML, in page order. */
const cardsOf = (html: string) =>
  html
    .split(/<li><article class="work-card">/)
    .slice(1)
    .map((card) => card.slice(0, card.indexOf("</article></li>")));

const idsOf = (html: string) =>
  cardsOf(html).map((card) => Number(card.match(/href="\/works\/(\d+)"/)?.[1]));

const cardOf = (html: string, id: number) =>
  cardsOf(html).find((card) => card.includes(`href="/works/${id}"`)) ?? "";

/** The links in the page's pager, unescaped. */
const pagerLinks = (html: string) =>
  [...(html.match(/<nav class="pager"[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/href="([^"]+)"/g)].map(
    ([, href = ""]) => href.replaceAll("&amp;", "&"),
  );

beforeAll(async () => {
  for (const [i, id] of OURS.entries()) {
    await seedWork(db, {
      ao3WorkId: id,
      updatedAt: `2019-03-${String(i + 1).padStart(2, "0")}`,
      rating: i === 0 ? "Explicit" : i === 1 ? null : "General Audiences",
      tags: [{ type: "fandom", name: FANDOM }],
    });
  }
  const marked = await seedWork(db, {
    ao3WorkId: 36030,
    rating: "General Audiences",
    tags: [{ type: "fandom", name: FANDOM }],
  });
  await db
    .updateTable("works")
    .set({ adult_marked: true })
    .where("id", "=", marked.workId)
    .execute();
  await seedWork(db, {
    ao3WorkId: 36040,
    status: "hidden",
    hiddenCause: "removal_request",
    tags: [{ type: "fandom", name: FANDOM }],
  });
  await seedWork(db, {
    ao3WorkId: 36041,
    status: "removed",
    tags: [{ type: "fandom", name: FANDOM }],
  });
  for (const [id, status] of [
    [36042, "held"],
    [36043, "processing"],
  ] as const) {
    const { workId } = await seedWork(db, {
      ao3WorkId: id,
      tags: [{ type: "fandom", name: FANDOM }],
    });
    await db.updateTable("works").set({ status }).where("id", "=", workId).execute();
  }
});

describe("15-search blank search", () => {
  it("The home page links to all works", async () => {
    const home = await htmlOf("/");
    const recent = home.indexOf("<h2>Recently added</h2>");
    const link = home.indexOf('<a href="/search">All works</a>');
    expect(recent).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(recent);

    const empty = homeHtml({ fandoms: [], works: [], updates: [] });
    expect(empty).not.toContain('href="/search"');
  });

  it("A blank search lists every live work", async () => {
    // From the home page, by its link.
    const home = await htmlOf("/");
    const href = home.match(/<a href="([^"]+)">All works<\/a>/)?.[1];
    expect(href).toBe("/search");
    const first = await htmlOf(href!);
    expect(cardsOf(first)).toHaveLength(20);
    expect(pagerLinks(first)).toContain("/search?page=2");

    // Narrowed to this file's works, the pages hold each of them exactly once.
    const seen: number[] = [];
    let next: string | undefined = `/search?${NARROW}`;
    while (next !== undefined) {
      const page = await htmlOf(next);
      seen.push(...idsOf(page));
      next = page.match(/<a rel="next" href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...OURS, 36030].sort((a, b) => a - b));
  });

  it("A blank search sorts and filters like a results page", async () => {
    const page = await htmlOf("/search");
    expect(page).toContain('<form role="search" method="get" action="/search">');
    // Best match first and chosen, though a blank search has nothing to match.
    expect(page).toContain('<option value="relevance" selected>Best match</option>');

    const explicit = await htmlOf(`/search?rating=Explicit&${NARROW}`);
    expect(idsOf(explicit)).toEqual([36000]);

    // Updated date is the default: newest first.
    const updated = idsOf(await htmlOf(`/search?${NARROW}`));
    expect(updated.slice(0, 2)).toEqual([36030, 36020]);
    const words = await htmlOf(`/search?sort=words&rating=Explicit&${NARROW}`);
    expect(idsOf(words)).toEqual([36000]);
  });

  it("A blank search leaves out every work that isn't live", async () => {
    const seen: number[] = [];
    for (const n of [1, 2]) seen.push(...idsOf(await htmlOf(`/search?${NARROW}&page=${n}`)));
    for (const id of [36040, 36041, 36042, 36043]) expect(seen).not.toContain(id);
  });

  it("A blank search shows adult works as every listing does", async () => {
    const html = (await htmlOf(`/search?${NARROW}`)) + (await htmlOf(`/search?${NARROW}&page=2`));
    expect(cardOf(html, 36000)).toContain("<strong>Explicit</strong>");
    expect(cardOf(html, 36001)).toContain("<strong>Not Rated</strong>");
    expect(cardOf(html, 36030)).toContain('<p class="card-adult">');
    expect(cardOf(html, 36000)).toContain('<a href="/works/36000">');
  });

  it("A blank search past the last page", async () => {
    expect((await fetchW(`/search?${NARROW}&page=3`)).status).toBe(404);
    expect((await fetchW("/search?page=999999999")).status).toBe(404);

    const empty = allWorksHtml({
      works: [],
      total: 0,
      page: 1,
      query: { q: "", sort: "relevance" },
    });
    expect(empty).toContain("There are no works here yet.");
    expect(
      allWorksHtml({
        works: [],
        total: 0,
        page: 2,
        query: { q: "", sort: "relevance" },
      }),
    ).toBeNull();
  });

  it("A blank search is briefly cached", async () => {
    const res = await fetchW("/search");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60, stale-while-revalidate=60");
    // A query is a reader's private input: its page is never kept.
    const searched = await fetchW("/search?q=allworkswebnomatch", {
      headers: { "cf-connecting-ip": freshIp() },
    });
    expect(searched.headers.get("Cache-Control") ?? "").not.toContain("max-age");
  });
});
