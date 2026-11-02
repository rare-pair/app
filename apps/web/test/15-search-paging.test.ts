import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Work IDs 33100-33199 and the made-up words below are this file's alone: one database
// serves every test file in the project, and a search sees whatever matches.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(async () => {
  await db.destroy();
});

const hasWork = (html: string, id: number) => html.includes(`href="/works/${id}"`);

/** The hrefs of the page's links with this rel, as a browser would read them. */
const relHref = (html: string, rel: string) => {
  const raw = html.match(new RegExp(`<a rel="${rel}" href="([^"]*)"`))?.[1];
  return raw === undefined ? null : raw.replaceAll("&amp;", "&");
};

const get = (path: string) => fetchW(path);

const WORD = "pagequillen";
const FIRST = 33101;
/** 21 works share WORD, one more than a page holds. */
const COUNT = 21;
const shown = (html: string) =>
  Array.from({ length: COUNT }, (_, i) => FIRST + i).filter((id) => hasWork(html, id)).length;
const FILTERED_WORD = "filterquillen";
const FANDOM = "Pagingverse Chronicles";
const FILTERED_MATURE = 33150;
const FILTERED_TEEN = 33151;
const FILTERED_OTHER_FANDOM = 33152;

describe("15-search paging and filters", () => {
  beforeAll(async () => {
    for (let i = 0; i < COUNT; i++) {
      await seedWork(db, { ao3WorkId: FIRST + i, title: `${WORD} number ${i}` });
    }
    await seedWork(db, {
      ao3WorkId: FILTERED_MATURE,
      title: `${FILTERED_WORD} mature`,
      rating: "Mature",
      tags: [{ type: "fandom", name: FANDOM }],
    });
    await seedWork(db, {
      ao3WorkId: FILTERED_TEEN,
      title: `${FILTERED_WORD} teen`,
      rating: "Teen And Up Audiences",
      tags: [{ type: "fandom", name: FANDOM }],
    });
    await seedWork(db, {
      ao3WorkId: FILTERED_OTHER_FANDOM,
      title: `${FILTERED_WORD} elsewhere`,
      rating: "Mature",
      tags: [{ type: "fandom", name: "Otherpagingverse" }],
    });
  }, 120_000);

  describe("Results are paged with real URLs", () => {
    it("Results are paged with real URLs", async () => {
      const first = await get(`/search?q=${WORD}`);
      expect(first.status).toBe(200);
      const html = await first.text();
      expect(relHref(html, "next")).toBe(`/search?q=${WORD}&page=2`);
      expect(relHref(html, "prev")).toBeNull();
      // 20 on a page, and the 21st on the next.
      expect(shown(html)).toBe(20);

      const second = await get(relHref(html, "next") ?? "/missing");
      expect(second.status).toBe(200);
      const html2 = await second.text();
      expect(shown(html2)).toBe(1);
      expect(relHref(html2, "prev")).toBe(`/search?q=${WORD}`);
    });

    it("A page past the last is not found", async () => {
      const res = await get(`/search?q=${WORD}&page=3`);
      expect(res.status).toBe(404);
      // The URL holds the reader's query, so the 404 keeps it out of the Referer too.
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin");
    });

    it("A page that isn't a number is the first", async () => {
      for (const page of ["abc", "0"]) {
        const res = await get(`/search?q=${WORD}&page=${page}`);
        expect(res.status, page).toBe(200);
        expect(relHref(await res.text(), "prev"), page).toBeNull();
      }
    });

    it("A page of no results is still the first page", async () => {
      const res = await get("/search?q=zzzxqvnomatchever&page=1");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("No works match your search.");
    });

    it("A blank query ignores the page", async () => {
      expect((await get("/search?q=&page=9")).status).toBe(200);
    });
  });

  describe("Results can be filtered", () => {
    const search = async (params: string) => {
      const res = await get(`/search?${params}`);
      expect(res.status, params).toBe(200);
      return res.text();
    };

    it("Results can be filtered", async () => {
      const byFandom = await search(`q=${FILTERED_WORD}&fandom=${encodeURIComponent(FANDOM)}`);
      expect(hasWork(byFandom, FILTERED_MATURE)).toBe(true);
      expect(hasWork(byFandom, FILTERED_TEEN)).toBe(true);
      expect(hasWork(byFandom, FILTERED_OTHER_FANDOM)).toBe(false);

      const byRating = await search(`q=${FILTERED_WORD}&rating=Mature`);
      expect(hasWork(byRating, FILTERED_MATURE)).toBe(true);
      expect(hasWork(byRating, FILTERED_OTHER_FANDOM)).toBe(true);
      expect(hasWork(byRating, FILTERED_TEEN)).toBe(false);

      const both = await search(
        `q=${FILTERED_WORD}&fandom=${encodeURIComponent(FANDOM)}&rating=Mature`,
      );
      expect(hasWork(both, FILTERED_MATURE)).toBe(true);
      expect(hasWork(both, FILTERED_TEEN)).toBe(false);
      expect(hasWork(both, FILTERED_OTHER_FANDOM)).toBe(false);
    });

    it("The form is a GET form that keeps the query and the filters", async () => {
      const html = await search(
        `q=${FILTERED_WORD}&fandom=${encodeURIComponent(`${FANDOM}"><b>`)}&rating=Mature`,
      );
      expect(html).toMatch(/<form role="search" method="get" action="\/search">/);
      expect(html).toContain(`id="q" name="q" value="${FILTERED_WORD}"`);
      // Reader input is escaped in the attribute.
      expect(html).toContain(`name="fandom" type="text" value="${FANDOM}&quot;&gt;&lt;b&gt;"`);
      expect(html).not.toContain("<b>");
      expect(html).toMatch(/<option value="Mature" selected>/);
      // The form has no page field, so applying a filter returns to the first page.
      expect(html).not.toContain('name="page"');
    });

    it("A very long fandom is cut, not echoed whole", async () => {
      const html = await search(`q=${FILTERED_WORD}&fandom=${"x".repeat(5000)}`);
      expect(html).not.toContain("x".repeat(201));
    });

    it("An unknown rating is dropped", async () => {
      const html = await search(`q=${FILTERED_WORD}&rating=Nonsense`);
      expect(hasWork(html, FILTERED_TEEN)).toBe(true);
      expect(html).not.toContain("Nonsense");
    });

    it("A fandom naming no tag finds nothing", async () => {
      const html = await search(`q=${FILTERED_WORD}&fandom=Nowhereverse`);
      expect(html).toContain("No works match your search.");
    });

    it("Filters without a query show no results", async () => {
      const html = await search(`fandom=${encodeURIComponent(FANDOM)}`);
      expect(hasWork(html, FILTERED_MATURE)).toBe(false);
      expect(html).not.toContain("No works match your search.");
    });

    it("Filters are kept across pages", async () => {
      // Every WORD work has no fandom, so a filter that names one has no second page; use
      // the rating, which all 21 share ("General Audiences").
      const html = await search(`q=${WORD}&rating=${encodeURIComponent("General Audiences")}`);
      expect(relHref(html, "next")).toBe(`/search?q=${WORD}&rating=General+Audiences&page=2`);
      const second = await search(
        `q=${WORD}&rating=${encodeURIComponent("General Audiences")}&page=2`,
      );
      expect(shown(second)).toBe(1);
      expect(relHref(second, "prev")).toBe(`/search?q=${WORD}&rating=General+Audiences`);
    });
  });
});
