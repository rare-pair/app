import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, nonceOf } from "./helpers";

// Work IDs 33000-33099 and the made-up words below are this file's alone: one database
// serves every test file in the project, and a search sees whatever matches.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(async () => {
  await db.destroy();
});

const searchPage = async (q: string) => {
  const res = await fetchW(`/search?q=${encodeURIComponent(q)}`);
  expect(res.status, q).toBe(200);
  return res.text();
};

const hasWork = (html: string, id: number) => html.includes(`href="/works/${id}"`);

/** Each card's inner HTML, in page order. */
const cardsOf = (html: string) =>
  html
    .split(/<li><article class="work-card">/)
    .slice(1)
    .map((card) => card.slice(0, card.indexOf("</article></li>")));

const cardOf = (html: string, id: number) =>
  cardsOf(html).find((card) => card.includes(`href="/works/${id}"`)) ?? "";

const lineOf = (card: string, className: string) =>
  card.match(new RegExp(`<(p|div) class="${className}">([\\s\\S]*?)</\\1>`))?.[2] ?? null;

// W1 is the scenario's work, with made-up words in place of its own.
const W1 = 33001;
const W2 = 33002;
const W3 = 33003;
const RATED = 33004;
const UNRATED = 33005;
const SECOND = 33006;

describe("15-search", () => {
  beforeAll(async () => {
    await seedWork(db, {
      ao3WorkId: W1,
      title: "The Glimmerquay Keeper",
      authors: [
        { pseud: "saltquillan", ao3_user: "saltquillan" },
        { pseud: "brineharrow", ao3_user: "brineharrow" },
      ],
      tags: [{ type: "freeform", name: "Hearthmoss Kin" }],
      summary: "<p>A zorplethwick rolls in over the <em>bay</em>.</p>",
    });
    await seedWork(db, {
      ao3WorkId: W2,
      title: "Plain Title",
      chapters: [{ title: "Vexillarium Chapter" }],
    });
    await seedWork(db, {
      ao3WorkId: W3,
      title: "Glimmerquay Nights",
      status: "hidden",
      hiddenCause: "removal_request",
    });
    await seedWork(db, {
      ao3WorkId: RATED,
      title: "Quorblat Mature Piece",
      rating: "Mature",
      tags: [
        { type: "warning", name: "Creator Chose Not To Use Archive Warnings" },
        { type: "warning", name: "Graphic Depictions Of Violence" },
      ],
    });
    await seedWork(db, { ao3WorkId: UNRATED, title: "Quorblat Unrated Piece", rating: null });
    await seedWork(db, { ao3WorkId: SECOND, title: "Quorblat Second" });
  });

  describe("Search is a GET form", () => {
    it("Search is a GET form", async () => {
      const res = await fetchW("/search?q=glimmerquay%20keeper");
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(html).toContain('<form role="search" method="get" action="/search">');
      expect(html).toContain('<input type="search" id="q" name="q" value="glimmerquay keeper">');
      // The results are in the first response, with no script to fetch them.
      expect(hasWork(html, W1)).toBe(true);
      expect(html).not.toContain("<script");
    });

    it("The home page's search box is a GET form to /search", async () => {
      const html = await (await fetchW("/")).text();

      expect(html).toContain('method="get" action="/search"');
      expect(html).toContain('name="q"');
    });

    it("The query is escaped where it is echoed", async () => {
      const html = await searchPage('"><script>alert(1)</script>');

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    });

    it("Odd text is echoed intact and does not break the page", async () => {
      for (const q of ["!!!", "-x", `a&b 'c' "d" 50% _ \\`]) {
        const html = await searchPage(q);

        expect(html, q).toContain('<form role="search"');
        expect(html, q).toContain(
          `value="${q.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")}"`,
        );
      }
    });

    it("The page keeps the query out of a cross-site Referer", async () => {
      const res = await fetchW("/search?q=quorblat");

      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    });

    it("A missing or empty query shows the empty form and no results", async () => {
      for (const path of ["/search", "/search?q=", "/search?q=%20%20"]) {
        const res = await fetchW(path);
        const html = await res.text();

        expect(res.status, path).toBe(200);
        expect(html, path).toContain('<form role="search"');
        expect(html, path).not.toContain('class="work-list"');
      }
    });

    it("A search with no match says so", async () => {
      const html = await searchPage("nothingmatchesthisxyzzyplugh");

      expect(html).toContain("No works match your search.");
      expect(html).not.toContain('class="work-list"');
    });

    it("The page has a fresh nonce and is not cached", async () => {
      const a = await fetchW("/search?q=quorblat");
      const b = await fetchW("/search?q=quorblat");
      const nonceA = nonceOf(a.headers.get("content-security-policy"));

      expect(nonceA).not.toBeNull();
      expect(nonceA).not.toBe(nonceOf(b.headers.get("content-security-policy")));
      expect(a.headers.get("cache-control")).toBe("private, no-store");
    });
  });

  describe("Result cards show rating and warnings", () => {
    it("Result cards show rating and warnings", async () => {
      const html = await searchPage("quorblat");

      expect(lineOf(cardOf(html, RATED), "card-rating")).toBe(
        "<strong>Mature · Creator Chose Not To Use Archive Warnings, Graphic Depictions Of Violence</strong>",
      );
      expect(lineOf(cardOf(html, UNRATED), "card-rating")).toBe(
        "<strong>Not Rated · No Archive Warnings Apply</strong>",
      );
    });
  });

  describe("Search needs no account", () => {
    it("Search needs no account", async () => {
      const res = await fetchW("/search?q=quorblat");
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(hasWork(html, SECOND)).toBe(true);
    });
  });

  describe("Metadata search through the page", () => {
    it("Search by title", async () => {
      expect(hasWork(await searchPage("glimmerquay keeper"), W1)).toBe(true);
    });

    it("Search by author", async () => {
      expect(hasWork(await searchPage("saltquillan"), W1)).toBe(true);
      expect(hasWork(await searchPage("brineharrow"), W1)).toBe(true);
    });

    it("Search by tag", async () => {
      expect(hasWork(await searchPage("hearthmoss kin"), W1)).toBe(true);
    });

    it("Search by summary", async () => {
      expect(hasWork(await searchPage("zorplethwick"), W1)).toBe(true);
      // Markup words in the summary are not matched.
      expect(hasWork(await searchPage("em"), W1)).toBe(false);
    });

    it("Fuzzy matching tolerates typos", async () => {
      expect(hasWork(await searchPage("glimmerqay keper"), W1)).toBe(true);
    });

    it("Chapter text is not searched", async () => {
      expect(hasWork(await searchPage("vexillarium"), W2)).toBe(false);
    });

    it("Hidden works are left out of results", async () => {
      const html = await searchPage("glimmerquay");

      expect(hasWork(html, W1)).toBe(true);
      expect(hasWork(html, W3)).toBe(false);
    });
  });
});
