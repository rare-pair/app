import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, STRICT, withoutNonce } from "./helpers";

// Work IDs 30000-31999 and these tag names are this file's alone: one database
// serves every test file in the project, and a listing sees whatever shares its tag.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(async () => {
  await db.destroy();
});

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

/** The card that links to this work, or "" when the page has none. */
const cardOf = (html: string, ao3WorkId: number) =>
  cardsOf(html).find((card) => card.includes(`href="/works/${ao3WorkId}"`)) ?? "";

/** The inner HTML of the card's element with this class, or null. */
const lineOf = (card: string, className: string) =>
  card.match(new RegExp(`<(p|div) class="${className}">([\\s\\S]*?)</\\1>`))?.[2] ?? null;

/** The text a reader sees: tags dropped, the five escapes undone. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const stylesheetOf = async (html: string) => {
  const href = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
  return htmlOf(href ?? "/missing.css");
};

/** The declarations of every rule whose selector names this class. */
const rulesFor = (css: string, className: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .flatMap(([, selector = "", body = ""]) =>
      new RegExp(`\\.${className}\\b`).test(selector) ? [body] : [],
    )
    .join("\n");

const SYMBOLS = /<img|<svg|\p{Extended_Pictographic}/u;

describe("14-browse-and-home", () => {
  beforeAll(async () => {
    await seedWork(db, { ao3WorkId: 30001, tags: [{ type: "fandom", name: "Harry Potter" }] });
    await seedWork(db, { ao3WorkId: 30002, tags: [{ type: "fandom", name: "harry  potter!" }] });
    await seedWork(db, {
      ao3WorkId: 30003,
      status: "hidden",
      hiddenCause: "removal_request",
      tags: [{ type: "fandom", name: "Harry Potter" }],
    });
  });

  it("Tag matching uses the normalized form", async () => {
    const html = await htmlOf("/tags/fandom/harry%20potter");

    expect(cardOf(html, 30001)).toContain(">Harry Potter</a>");
    expect(cardOf(html, 30002)).toContain(">harry  potter!</a>");
    // Hidden works are left out of listings.
    expect(html).not.toContain('href="/works/30003"');
  });

  it("Work card line order", async () => {
    await seedWork(db, {
      ao3WorkId: 30010,
      title: "Line Order Title",
      authors: [{ pseud: "Line Order Author", ao3_user: "line_order" }],
      rating: "Teen And Up Audiences",
      summary: "<p>Line order summary.</p>",
      chapters: [{ words: 1500 }],
      updatedAt: "2024-03-05T00:00:00Z",
      tags: [
        { type: "freeform", name: "Line Order Freeform" },
        { type: "character", name: "Line Order Character" },
        { type: "relationship", name: "Line Order A/B" },
        { type: "fandom", name: "Line Order Fandom" },
        { type: "warning", name: "No Archive Warnings Apply" },
        { type: "rating", name: "Teen And Up Audiences" },
      ],
    });

    const card = cardOf(await htmlOf("/tags/fandom/line%20order%20fandom"), 30010);

    const lines = [
      "Line Order Title",
      "Line Order Author",
      "Teen And Up Audiences · No Archive Warnings Apply",
      "Line Order Fandom",
      "Line order summary.",
      "Line Order A/B",
      "1,500 words",
    ];
    const at = lines.map((text) => card.indexOf(text));
    expect(
      at.every((i) => i >= 0),
      JSON.stringify(at),
    ).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("Rating and warnings spelled out on cards", async () => {
    await seedWork(db, {
      ao3WorkId: 30020,
      rating: "Mature",
      tags: [
        { type: "rating", name: "Mature" },
        { type: "warning", name: "Graphic Depictions Of Violence" },
        { type: "fandom", name: "Spelled Out Fandom" },
      ],
    });
    await seedWork(db, {
      ao3WorkId: 30021,
      rating: null,
      tags: [{ type: "fandom", name: "Spelled Out Fandom" }],
    });
    await seedWork(db, {
      ao3WorkId: 30022,
      rating: "",
      tags: [{ type: "fandom", name: "Spelled Out Fandom" }],
    });

    const html = await htmlOf("/tags/fandom/spelled%20out%20fandom");

    const card = cardOf(html, 30020);
    expect(lineOf(card, "card-rating")).toBe(
      "<strong>Mature · Graphic Depictions Of Violence</strong>",
    );
    expect(lineOf(cardOf(html, 30021), "card-rating")).toBe("<strong>Not Rated</strong>");
    expect(lineOf(cardOf(html, 30022), "card-rating")).toBe("<strong>Not Rated</strong>");
    expect(card).not.toMatch(SYMBOLS);
    expect(card).not.toMatch(/style=/);
    expect(rulesFor(await stylesheetOf(html), "card-rating")).not.toMatch(/color|background/);
  });

  // The 360 px layout itself needs a browser: here, the HTML and the stylesheet.
  it("Warnings line is never truncated", async () => {
    const warnings = [
      "Creator Chose Not To Use Archive Warnings",
      "Graphic Depictions Of Violence",
      "Major Character Death",
    ];
    await seedWork(db, {
      ao3WorkId: 30030,
      rating: "Explicit",
      tags: [
        ...warnings.map((name) => ({ type: "warning" as const, name })),
        { type: "fandom", name: "Long Warnings Fandom" },
      ],
    });

    const html = await htmlOf("/tags/fandom/long%20warnings%20fandom");

    expect(textOf(lineOf(cardOf(html, 30030), "card-rating") ?? "")).toBe(
      `Explicit · ${warnings.join(", ")}`,
    );
    const css = await stylesheetOf(html);
    expect(rulesFor(css, "card-rating")).toMatch(/overflow-wrap:\s*anywhere/);
    // Nor anything the line sits in: the card and its lines.
    for (const className of ["card-rating", "work-card", "work-list"]) {
      expect(rulesFor(css, className), className).not.toMatch(
        /line-clamp|overflow:\s*hidden|text-overflow|white-space:\s*nowrap|max-height|\bheight/,
      );
    }
  });

  it("Summary is clamped with a more link", async () => {
    const summary = Array.from(
      { length: 12 },
      (_, i) => `<p>Clamped summary paragraph ${i + 1}, long enough to fill a line.</p>`,
    ).join("");
    await seedWork(db, {
      ao3WorkId: 30040,
      summary,
      tags: [{ type: "fandom", name: "Clamped Summary Fandom" }],
    });
    await seedWork(db, {
      ao3WorkId: 30041,
      summary: null,
      tags: [{ type: "fandom", name: "Clamped Summary Fandom" }],
    });
    // Markup with nothing to read is no summary either.
    await seedWork(db, {
      ao3WorkId: 30042,
      summary: "<p> &nbsp;&#160;&#xA0;&emsp;&zwnj;​</p><br>",
      tags: [{ type: "fandom", name: "Clamped Summary Fandom" }],
    });

    const html = await htmlOf("/tags/fandom/clamped%20summary%20fandom");

    const card = cardOf(html, 30040);
    expect(lineOf(card, "card-summary")).toBe(summary);
    // Named for its work, so a list of links tells each "more" apart.
    const more = card.indexOf(
      '<a href="/works/30040" aria-label="more of Seeded work 30040">more</a>',
    );
    expect(more).toBeGreaterThan(card.indexOf("Clamped summary paragraph 12"));
    const noSummary = cardOf(html, 30041);
    expect(noSummary).toContain('href="/works/30041"');
    expect(noSummary).not.toContain(">more</a>");
    const blank = cardOf(html, 30042);
    expect(blank).toContain('href="/works/30042"');
    expect(blank).not.toMatch(/card-summary|>more<\/a>/);
    const rules = rulesFor(await stylesheetOf(html), "card-summary");
    expect(rules).toMatch(/(^|[^-])line-clamp:\s*3/);
    expect(rules).toMatch(/-webkit-line-clamp:\s*3/);
  });

  it("Card tags order", async () => {
    const freeforms = Array.from({ length: 21 }, (_, i) => ({
      type: "freeform" as const,
      name: `Tags Order Freeform ${i + 1}`,
    }));
    await seedWork(db, {
      ao3WorkId: 30050,
      tags: [
        { type: "fandom", name: "Tags Order Fandom" },
        { type: "category", name: "M/M" },
        ...freeforms.slice(0, 10),
        { type: "character", name: "Tags Order Ann" },
        { type: "relationship", name: "Tags Order Ann/Bea" },
        ...freeforms.slice(10),
        { type: "character", name: "Tags Order Bea" },
        { type: "relationship", name: "Tags Order Ann & Bea" },
      ],
    });
    // More than three of a kind: three show, then how many more.
    await seedWork(db, {
      ao3WorkId: 30051,
      tags: [
        { type: "fandom", name: "Tags Order Fandom" },
        ...[1, 2, 3, 4, 5].map((n) => ({ type: "relationship" as const, name: `Tags R${n}/X` })),
        ...[1, 2, 3, 4].map((n) => ({ type: "character" as const, name: `Tags C${n}` })),
        { type: "freeform", name: "Tags Order Lone Freeform" },
      ],
    });

    const html = await htmlOf("/tags/fandom/tags%20order%20fandom");

    const line = lineOf(cardOf(html, 30050), "card-tags") ?? "";
    // Each tag's type is read out first (A11Y); the labels are visually hidden.
    expect(textOf(line)).toBe(
      "Relationship: Tags Order Ann/Bea, Relationship: Tags Order Ann & Bea · Character: Tags Order Ann, Character: Tags Order Bea · 21 other tags",
    );
    expect(line).toContain('<a href="/tags/relationship/tags%20order%20ann%2Fbea">');
    expect(line).toContain('<a href="/tags/character/tags%20order%20ann">');
    expect(textOf(lineOf(cardOf(html, 30051), "card-tags") ?? "")).toBe(
      "Relationship: Tags R1/X, Relationship: Tags R2/X, Relationship: Tags R3/X, +2 more · Character: Tags C1, Character: Tags C2, Character: Tags C3, +1 more · 1 other tag",
    );
    // A tag that folds to nothing has no listing to link to.
    await seedWork(db, {
      ao3WorkId: 30052,
      tags: [
        { type: "fandom", name: "Tags Order Fandom" },
        { type: "character", name: "???" },
      ],
    });
    const again = await htmlOf("/tags/fandom/tags%20order%20fandom");
    expect(lineOf(cardOf(again, 30052), "card-tags")).toBe(
      '<span class="visually-hidden">Character: </span>???',
    );
    // Tags are in small type (FRONTEND-DISCOVERY, Tag list).
    expect(rulesFor(await stylesheetOf(html), "card-tags")).toMatch(/font-size:\s*var\(--text-1\)/);
  });

  it("Card stats line", async () => {
    await seedWork(db, {
      ao3WorkId: 30060,
      chapters: [{ words: 1200 }, { words: 1300 }, { words: 2000 }],
      chapterTotal: 5,
      complete: false,
      updatedAt: "2024-03-05T00:00:00Z",
      tags: [{ type: "fandom", name: "Stats Line Fandom" }],
    });
    // The total unknown, and a finished work.
    await seedWork(db, {
      ao3WorkId: 30061,
      chapters: [{ words: 800 }],
      complete: true,
      updatedAt: "2023-11-20T00:00:00Z",
      tags: [{ type: "fandom", name: "Stats Line Fandom" }],
    });

    const html = await htmlOf("/tags/fandom/stats%20line%20fandom");

    expect(textOf(lineOf(cardOf(html, 30060), "card-stats") ?? "")).toBe(
      "4,500 words · 3/5 chapters · In progress · Updated 2024-03-05",
    );
    expect(textOf(lineOf(cardOf(html, 30061), "card-stats") ?? "")).toBe(
      "800 words · 1/? chapters · Complete · Updated 2023-11-20",
    );
    // Never updated since it was published: the published date is the last update.
    await seedWork(db, {
      ao3WorkId: 30062,
      chapters: [{ words: 300 }],
      chapterTotal: 1,
      updatedAt: null,
      tags: [{ type: "fandom", name: "Stats Line Fandom" }],
    });
    const again = await htmlOf("/tags/fandom/stats%20line%20fandom");
    expect(textOf(lineOf(cardOf(again, 30062), "card-stats") ?? "")).toBe(
      "300 words · 1/1 chapters · Complete · Updated 2020-01-01",
    );
  });

  it("Anonymous work card", async () => {
    await seedWork(db, {
      ao3WorkId: 30070,
      anonymous: true,
      tags: [{ type: "fandom", name: "Anonymous Card Fandom" }],
    });

    // No byline at all reads the same.
    await seedWork(db, {
      ao3WorkId: 30071,
      authors: [],
      tags: [{ type: "fandom", name: "Anonymous Card Fandom" }],
    });

    const html = await htmlOf("/tags/fandom/anonymous%20card%20fandom");

    expect(textOf(lineOf(cardOf(html, 30070), "card-byline") ?? "")).toBe("by Anonymous");
    expect(textOf(lineOf(cardOf(html, 30071), "card-byline") ?? "")).toBe("by Anonymous");
  });
});

describe("14-browse-and-home tag listing URLs", () => {
  it("A relationship's / and & stay in one path segment, as different tags", async () => {
    await seedWork(db, {
      ao3WorkId: 30080,
      tags: [{ type: "relationship", name: "Url Kirk/Spock" }],
    });
    await seedWork(db, {
      ao3WorkId: 30081,
      tags: [{ type: "relationship", name: "Url Kirk & Spock" }],
    });

    const slash = await htmlOf("/tags/relationship/url%20kirk%2Fspock");
    const and = await htmlOf("/tags/relationship/url%20kirk%26spock");

    expect(slash).toContain("<h1>Url Kirk/Spock (relationship)</h1>");
    expect(cardOf(slash, 30080)).not.toBe("");
    expect(cardOf(slash, 30081)).toBe("");
    expect(and).toContain("<h1>Url Kirk &amp; Spock (relationship)</h1>");
    expect(cardOf(and, 30081)).not.toBe("");
    expect(cardOf(and, 30080)).toBe("");
  });

  it("The heading is the first spelling a live work uses, by code unit", async () => {
    await seedWork(db, { ao3WorkId: 30090, tags: [{ type: "fandom", name: "url heading" }] });
    await seedWork(db, { ao3WorkId: 30091, tags: [{ type: "fandom", name: "Url  Heading!" }] });
    // First by code unit, but only a hidden work uses it: nothing of it is shown.
    await seedWork(db, {
      ao3WorkId: 30092,
      status: "hidden",
      hiddenCause: "reports",
      tags: [{ type: "fandom", name: "URL HEADING" }],
    });

    const html = await htmlOf("/tags/fandom/url%20heading");

    expect(html.match(/<h1>([^<]*)<\/h1>/g)).toEqual(["<h1>Url  Heading! (fandom)</h1>"]);
    expect(html).not.toContain("URL HEADING");
  });

  it("A tag with no live works lists no works, and shows nothing of the others", async () => {
    await seedWork(db, {
      ao3WorkId: 30100,
      status: "removed",
      tags: [{ type: "freeform", name: "Url Empty Freeform" }],
    });
    await seedWork(db, {
      ao3WorkId: 30101,
      status: "hidden",
      hiddenCause: "removal_request",
      tags: [{ type: "freeform", name: "Url Hidden Freeform!" }],
    });

    // A tag only removed or hidden works use reads the same as one nobody has used.
    for (const name of [
      "url%20empty%20freeform",
      "url%20hidden%20freeform",
      "url%20never%20seeded",
    ]) {
      const res = await fetchW(`/tags/freeform/${name}`);
      const html = await res.text();

      expect(res.status, name).toBe(200);
      // A fixed heading: the page repeats nothing a URL can say.
      expect(html.match(/<h1>([^<]*)<\/h1>/g), name).toEqual(["<h1>No works with this tag</h1>"]);
      expect(html).not.toContain(decodeURIComponent(name));
      // Nor anything of the removed and hidden works.
      expect(html).not.toMatch(/Url Empty Freeform|Url Hidden Freeform!|3010[01]|Seeded work/);
      expect(html).toContain("No works");
      expect(html).not.toContain("work-card");
    }
  });

  it("An unknown tag type, or a name with nothing left once folded, is not found", async () => {
    expect((await fetchW("/tags/genre/harry%20potter")).status).toBe(404);
    expect((await fetchW("/tags/fandom/%21%21%21")).status).toBe(404);
    // No tag can hold a NUL, and Postgres refuses one in a parameter.
    expect((await fetchW("/tags/fandom/a%00b")).status).toBe(404);
  });

  it("A summary's markup stays inside its card", async () => {
    // A bare list item, as the sanitizer can leave one: inside only a div, it would
    // close the card's own list item and stand in the list as a card of its own.
    const summary = '<li><h2><a href="https://elsewhere.example/">Not a card</a></h2></li>';
    await seedWork(db, {
      ao3WorkId: 30110,
      summary,
      tags: [{ type: "fandom", name: "Contained Summary Fandom" }],
    });

    const html = await htmlOf("/tags/fandom/contained%20summary%20fandom");

    // An article between the two list items stops the parser closing the outer one.
    expect(html).toContain(
      `<li><article class="work-card">\n<h2 class="card-title"><a href="/works/30110">`,
    );
    // The heading is bold text, the item a div and the link its text (A11Y); all inside
    // the card summary, which `lineOf` can't read once a div sits inside it.
    const card = cardOf(html, 30110);
    expect(card).toContain(
      '<div class="card-summary"><div><div class="summary-heading"><strong>Not a card</strong></div></div></div>',
    );
    expect(card).not.toMatch(/<li\b/);
    expect(card.match(/<h[1-6]\b/g)).toHaveLength(1);
    expect(card).toContain('<h2 class="card-title">');
    const css = await stylesheetOf(html);
    const summaryRules = rulesFor(css, "card-summary");
    expect(summaryRules).toMatch(/contain:\s*content/);
    // Three lines high at most, whatever the markup (a table isn't counted in lines).
    expect(summaryRules).toMatch(/max-height:\s*calc\(3 \* 1\.45em\)/);
    // Card styles name the card's own lines, so a summary's h2 or p doesn't pass for one,
    // and a summary's headings are already divs (tidySummary), so no rule reaches for a heading
    // tag inside it: one would be dead (#536).
    expect(css).not.toMatch(/\.work-card (h2|p)\b/);
    expect(css).not.toContain(".card-summary :is(");
    // An image is scaled to the clamp, not shown at its own height.
    // An image takes one of the three lines, not its own height.
    expect(css).toMatch(/\.card-summary img \{[^}]*max-height: 1\.45em/);
    // A list styled without bullets keeps its list semantics in Safari.
    expect(html).toContain('<ol class="work-list" role="list">');
  });

  it("A work page's tag links open the tag's listing", async () => {
    await seedWork(db, {
      ao3WorkId: 30120,
      tags: [
        { type: "fandom", name: "Linked Listing Fandom" },
        { type: "relationship", name: "Linked Ann/Bea" },
        // Its name_norm normalizes again to something else: the link still finds it.
        { type: "character", name: "Ι͂ Linked" },
      ],
    });

    const page = await htmlOf("/works/30120");
    const hrefs = [...page.matchAll(/href="(\/tags\/[^"]+)"/g)].map((m) => m[1] ?? "");

    expect(hrefs).toEqual([
      "/tags/fandom/linked%20listing%20fandom",
      "/tags/relationship/linked%20ann%2Fbea",
      "/tags/character/%CE%B9%CD%82%20linked",
    ]);
    for (const href of hrefs) {
      expect(cardOf(await htmlOf(href), 30120), href).not.toBe("");
    }
  });

  it("A tag listing has the strict policy, no script and no cookie", async () => {
    const res = await fetchW("/tags/fandom/harry%20potter");
    const html = await res.text();

    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).not.toMatch(/<script|<style|style=/i);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    const www = await fetchW("https://www.rarepair.fans/tags/fandom/harry%20potter?x=1");
    expect(www.status).toBe(308);
    expect(www.headers.get("location")).toBe(
      "https://rarepair.fans/tags/fandom/harry%20potter?x=1",
    );
  });
});

/** The AO3 work IDs of a listing's cards, in page order. */
const idsOf = (html: string) =>
  cardsOf(html).map((card) => Number(card.match(/href="\/works\/(\d+)"/)?.[1]));

/** IDs from `from` to `to`, inclusive. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Runs `seed` the first time it's called, so each describe that reads its works can ask for them. */
const once = (seed: () => Promise<void>) => {
  let seeded: Promise<void> | undefined;
  return () => (seeded ??= seed());
};

const PAGED = "/tags/fandom/paged%20listing%20fandom";

const seedPaged = once(async () => {
  // 45 works with one updated date, so AO3 work ID orders them; one hidden.
  for (const ao3WorkId of range(31001, 31045)) {
    await seedWork(db, { ao3WorkId, tags: [{ type: "fandom", name: "Paged Listing Fandom" }] });
  }
  await seedWork(db, {
    ao3WorkId: 31046,
    status: "hidden",
    hiddenCause: "reports",
    tags: [{ type: "fandom", name: "Paged Listing Fandom" }],
  });
});

describe("14-browse-and-home listing pages", () => {
  beforeAll(seedPaged);

  it("Twenty works fit on one page, and the twenty-first starts a second", async () => {
    for (const ao3WorkId of range(31401, 31421)) {
      await seedWork(db, {
        ao3WorkId,
        rating: ao3WorkId === 31421 ? "Mature" : "Explicit",
        tags: [{ type: "fandom", name: "Edge Listing Fandom" }],
      });
    }
    const edge = "/tags/fandom/edge%20listing%20fandom";

    // 21 works: a second page of one, and no third.
    expect(cardsOf(await htmlOf(edge))).toHaveLength(20);
    expect(idsOf(await htmlOf(`${edge}?page=2`))).toEqual([31421]);
    expect((await fetchW(`${edge}?page=3`)).status).toBe(404);
    // 20 works: one page, no pager, and no page 2.
    const twenty = await htmlOf(`${edge}?rating=Explicit`);
    expect(cardsOf(twenty)).toHaveLength(20);
    expect(twenty).not.toContain('class="pager"');
    expect((await fetchW(`${edge}?rating=Explicit&page=2`)).status).toBe(404);
    // A parameter given twice is read as its first value.
    expect(idsOf(await htmlOf(`${edge}?page=2&page=1`))).toEqual([31421]);
  });

  it("A long listing's pager links the first page, the last and two either side", async () => {
    // 141 works: eight pages.
    for (const ao3WorkId of range(31201, 31341)) {
      await seedWork(db, { ao3WorkId, tags: [{ type: "fandom", name: "Long Listing Fandom" }] });
    }
    const long = "/tags/fandom/long%20listing%20fandom";
    const numbersOf = async (page: number) =>
      [
        ...(
          (await htmlOf(`${long}?page=${page}`)).match(/<nav class="pager"[\s\S]*?<\/nav>/)?.[0] ??
          ""
        ).matchAll(/<li(?: aria-hidden="true")?>(?:<a [^>]*>|<span aria-current="page">)?([^<]+)/g),
      ].map((m) => m[1]);

    expect(await numbersOf(1)).toEqual(["1", "2", "3", "…", "8", "Next"]);
    expect(await numbersOf(6)).toEqual(["Previous", "1", "…", "4", "5", "6", "7", "8", "Next"]);
    // Only the first, the last and two either side: a gap of one page is still a gap.
    expect(await numbersOf(5)).toEqual([
      "Previous",
      "1",
      "…",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "Next",
    ]);
  }, 60_000);

  it("Tag listing shows paged works", async () => {
    const first = await htmlOf(PAGED);
    const pages = [first, await htmlOf(`${PAGED}?page=2`), await htmlOf(`${PAGED}?page=3`)];

    expect(pages.map((p) => cardsOf(p).length)).toEqual([20, 20, 5]);
    // Every work once, none twice, none missing.
    expect(pages.flatMap(idsOf)).toEqual(range(31001, 31045));
    expect(first).toMatch(/<nav class="pager" aria-label="Pages">/);
    expect(first).toContain(`<a rel="next" href="${PAGED}?page=2">`);
    // The heading is the tag's, whatever the page, sort or filter shows.
    for (const html of [...pages, await htmlOf(`${PAGED}?sort=words&rating=Explicit`)]) {
      expect(html.match(/<h1>[^<]*<\/h1>/g)).toEqual(["<h1>Paged Listing Fandom (fandom)</h1>"]);
    }
  });

  it("Pagination uses real links", async () => {
    const navOf = (html: string) => html.match(/<nav class="pager"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const linksOf = (html: string) =>
      [...navOf(html).matchAll(/<a (?:rel="(\w+)" )?href="([^"]+)">([^<]+)<\/a>/g)].map(
        ([, rel = "", href = "", text = ""]) => ({
          rel,
          href: href.replaceAll("&amp;", "&"),
          text,
        }),
      );
    const [one, two, three] = [
      await htmlOf(PAGED),
      await htmlOf(`${PAGED}?page=2`),
      await htmlOf(`${PAGED}?page=3`),
    ];

    expect(linksOf(two)).toEqual([
      { rel: "prev", href: PAGED, text: "Previous" },
      { rel: "", href: PAGED, text: "1" },
      { rel: "", href: `${PAGED}?page=3`, text: "3" },
      { rel: "next", href: `${PAGED}?page=3`, text: "Next" },
    ]);
    // The current page is marked, and not a link.
    expect(navOf(two)).toContain('<span aria-current="page">2</span>');
    expect(linksOf(one).map((l) => l.text)).toEqual(["2", "3", "Next"]);
    expect(linksOf(three).map((l) => l.text)).toEqual(["Previous", "1", "2"]);
    // Each link is a page of its own.
    for (const { href } of linksOf(two)) {
      expect(cardsOf(await htmlOf(href)), href).toHaveLength(href.endsWith("3") ? 5 : 20);
    }
    // No infinite scroll: nothing runs on the page.
    for (const html of [one, two, three]) expect(html).not.toMatch(/<script/i);
  });

  it("A malformed page number is the first page, and one past the last is not found", async () => {
    const first = idsOf(await htmlOf(PAGED));

    for (const page of ["0", "-1", "abc", "1.5", "2e1", ""]) {
      expect(idsOf(await htmlOf(`${PAGED}?page=${page}`)), page).toEqual(first);
    }
    for (const page of ["4", "99999999999999999999", String(Number.MAX_SAFE_INTEGER)]) {
      const res = await fetchW(`${PAGED}?page=${page}`);
      expect(res.status, page).toBe(404);
      expect(res.headers.get("cache-control") ?? "", page).not.toMatch(/max-age/);
    }
  });
});

const SORTED = "/tags/fandom/sorted%20listing%20fandom";

const seedSorted = once(async () => {
  const fandom = { type: "fandom" as const, name: "Sorted Listing Fandom" };
  const slowBurn = (name: string) => [fandom, { type: "freeform" as const, name }];
  const works = [
    [31101, "2021-03-01", 1200, "Explicit", true, slowBurn("Listing Slow Burn")],
    [31102, "2023-05-01", 7000, "Mature", true, slowBurn("listing slow-burn!")],
    // Never updated: its published date, 2020-01-01, stands in.
    [31103, null, 5000, null, false, slowBurn("Listing Slow Burn")],
    [31104, "2022-01-01", 300, "Explicit", false, [fandom]],
    [31105, "2020-06-01", 2500, "Explicit", true, [fandom]],
  ] as const;
  for (const [ao3WorkId, updated, words, rating, complete, tags] of works) {
    await seedWork(db, {
      ao3WorkId,
      updatedAt: updated && `${updated}T00:00:00Z`,
      chapters: [{ words }],
      rating,
      complete,
      tags: [...tags],
    });
  }
});

describe("14-browse-and-home listing sort and filters", () => {
  beforeAll(async () => {
    await seedPaged();
    await seedSorted();
  });

  it("Sort by updated date", async () => {
    const res = await fetchW(`${SORTED}?sort=updated`);

    expect(res.status).toBe(200);
    expect(idsOf(await res.text())).toEqual([31102, 31104, 31101, 31105, 31103]);
    // The default is the same order.
    expect(idsOf(await htmlOf(SORTED))).toEqual([31102, 31104, 31101, 31105, 31103]);
    // Page links keep the sort.
    expect(await htmlOf(`${PAGED}?sort=words&page=2`)).toContain(
      `<a rel="next" href="${PAGED}?sort=words&amp;page=3">`,
    );
  });

  it("Sort by word count", async () => {
    const html = await htmlOf(`${SORTED}?sort=words`);

    expect(idsOf(html)).toEqual([31102, 31103, 31105, 31101, 31104]);
    expect(cardsOf(html).map((card) => lineOf(card, "card-stats")?.split(" · ")[0])).toEqual([
      "7,000 words",
      "5,000 words",
      "2,500 words",
      "1,200 words",
      "300 words",
    ]);
    // A sort the form doesn't offer is the default.
    expect(idsOf(await htmlOf(`${SORTED}?sort=title`))).toEqual([
      31102, 31104, 31101, 31105, 31103,
    ]);
  });

  it("Filter by rating", async () => {
    const explicit = await htmlOf(`${SORTED}?rating=Explicit`);

    expect(idsOf(explicit)).toEqual([31104, 31101, 31105]);
    expect(idsOf(await htmlOf(`${SORTED}?rating=Not+Rated`))).toEqual([31103]);
    // A rating the form doesn't offer filters nothing.
    expect(idsOf(await htmlOf(`${SORTED}?rating=Bogus`))).toHaveLength(5);
  });

  it("Filter by tag and completion", async () => {
    const narrowed = await htmlOf(`${SORTED}?tag=Listing+Slow+Burn&tag_type=freeform&complete=yes`);

    // Both spellings of the tag, complete only.
    expect(idsOf(narrowed)).toEqual([31102, 31101]);
    expect(idsOf(await htmlOf(`${SORTED}?tag=listing+slow+burn&complete=no`))).toEqual([31103]);
    expect(idsOf(await htmlOf(`${SORTED}?complete=no`))).toEqual([31104, 31103]);
    // The name as another type is another tag.
    expect(await htmlOf(`${SORTED}?tag=Listing+Slow+Burn&tag_type=character`)).toContain(
      "No works match",
    );
    // A type the form doesn't offer is its default, freeform.
    expect(idsOf(await htmlOf(`${SORTED}?tag=Listing+Slow+Burn&tag_type=rating`))).toEqual([
      31102, 31101, 31103,
    ]);
    // A tag that names nothing, and an unknown completion, filter nothing.
    for (const ignored of ["tag=%21%21%21", "tag=a%00b", "tag=", "complete=maybe"]) {
      expect(idsOf(await htmlOf(`${SORTED}?${ignored}`)), ignored).toHaveLength(5);
    }
  });
});

/** A listing's GET form, read as a browser would: where it goes and each control's value. */
const formOf = (html: string) => {
  const form = html.match(
    /<form class="listing-filters" method="get" action="([^"]*)">([\s\S]*?)<\/form>/,
  );
  const body = form?.[2] ?? "";
  const fields = new Map<string, { value: string; options: string[] }>();
  const controls =
    /<select id="[^"]+" name="([^"]+)">([\s\S]*?)<\/select>|<input id="[^"]+" name="([^"]+)" type="text" value="([^"]*)">/g;
  for (const [, select, inner = "", input, value = ""] of body.matchAll(controls)) {
    if (input !== undefined) {
      fields.set(input, { value, options: [] });
      continue;
    }
    const options = [...inner.matchAll(/<option value="([^"]*)"( selected)?>/g)];
    const chosen = options.find((o) => o[2]) ?? options[0];
    fields.set(select ?? "", { value: chosen?.[1] ?? "", options: options.map((o) => o[1] ?? "") });
  }
  return { action: form?.[1] ?? "", fields, body };
};

/** The URL a browser submits the form to, with these controls changed. Empty values are sent too. */
const submit = (html: string, changes: Record<string, string>) => {
  const { action, fields } = formOf(html);
  const values = [...fields].map(([name, f]) => [name, textOf(changes[name] ?? f.value)]);
  return `${textOf(action)}?${new URLSearchParams(values).toString()}`;
};

/** The works the form, canonical and cache cases read. */
const seedListings = async () => {
  await seedPaged();
  await seedSorted();
};

describe("14-browse-and-home listing form", () => {
  beforeAll(seedListings);

  it("Sort and filter work without JS", async () => {
    const page = await htmlOf(SORTED);
    const { action, fields, body } = formOf(page);

    expect(action).toBe(SORTED);
    expect([...fields.keys()]).toEqual(["sort", "rating", "complete", "tag", "tag_type"]);
    expect(fields.get("sort")?.options).toEqual(["updated", "words"]);
    expect(fields.get("rating")?.options).toEqual([
      "",
      "General Audiences",
      "Teen And Up Audiences",
      "Mature",
      "Explicit",
      "Not Rated",
    ]);
    expect(fields.get("complete")?.options).toEqual(["", "yes", "no"]);
    expect(fields.get("tag_type")?.options).toEqual([
      "freeform",
      "fandom",
      "relationship",
      "character",
    ]);
    // Every control has a label, and the form a visible button.
    for (const id of body.matchAll(/<(?:select|input) id="([^"]+)"/g)) {
      expect(body).toContain(`<label for="${id[1]}">`);
    }
    expect(body).toMatch(/<button type="submit">[^<]+<\/button>/);

    const url = submit(page, { sort: "words", rating: "Explicit", complete: "yes" });
    const res = await fetchW(url);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(url).toContain("sort=words");
    expect(idsOf(html)).toEqual([31105, 31101]);
    // The page comes back with the choices made, ready to change again.
    const again = formOf(html).fields;
    expect([
      again.get("sort")?.value,
      again.get("rating")?.value,
      again.get("complete")?.value,
    ]).toEqual(["words", "Explicit", "yes"]);
    expect(html.match(/<h1>[^<]*<\/h1>/g)).toEqual(["<h1>Sorted Listing Fandom (fandom)</h1>"]);
    expect(html).not.toMatch(/<script|<style|style=/i);

    // A tag, submitted with its type; then a choice nothing matches, which can be undone.
    const narrowed = await htmlOf(submit(page, { tag: "Listing Slow Burn", complete: "no" }));
    expect(idsOf(narrowed)).toEqual([31103]);
    expect(formOf(narrowed).fields.get("tag")?.value).toBe("Listing Slow Burn");
    const none = await htmlOf(submit(page, { rating: "General Audiences" }));
    expect(none).toContain("<p>No works match these filters.</p>");
    expect(formOf(none).fields.get("rating")?.value).toBe("General Audiences");
  });

  it("What a reader types into the form stays text", async () => {
    const typed = `"><script>alert(1)</script>&x=1`;
    const html = await htmlOf(`${SORTED}?tag=${encodeURIComponent(typed)}`);

    expect(html).not.toMatch(/<script/i);
    expect(formOf(html).fields.get("tag")?.value).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;x=1",
    );
  });

  it("A listing names its canonical URL, with its sort and filters", async () => {
    const canonicalOf = async (path: string) =>
      (await htmlOf(path)).match(/<link rel="canonical" href="([^"]*)">/g);

    // The tag's folded name, the choices that aren't defaults, and no page 1.
    expect(
      await canonicalOf(
        "/tags/fandom/Sorted%20Listing%20Fandom?sort=words&rating=&complete=yes&tag=&tag_type=freeform&page=1",
      ),
    ).toEqual([`<link rel="canonical" href="${SORTED}?sort=words&amp;complete=yes">`]);
    // A narrowing tag is folded too, so its spellings share the page.
    for (const tag of ["Listing+Slow+Burn", "listing%20slow-burn%21"]) {
      expect(await canonicalOf(`${SORTED}?tag=${tag}`), tag).toEqual([
        `<link rel="canonical" href="${SORTED}?tag=listing+slow+burn&amp;tag_type=freeform">`,
      ]);
    }
    expect(await canonicalOf(`${PAGED}?page=2`)).toEqual([
      `<link rel="canonical" href="${PAGED}?page=2">`,
    ]);
  });
});

/**
 * The listing's cache header, on the listing and its variants, and on nothing that isn't one.
 * `private`: a page may carry one reader's cookies' effects, so no shared cache keeps it.
 */
async function expectShortListingCache() {
  for (const path of [
    SORTED,
    `${SORTED}?sort=words&rating=Explicit`,
    `${SORTED}?rating=General+Audiences`,
    `${PAGED}?page=3`,
    "/tags/freeform/url%20never%20seeded",
  ]) {
    const res = await fetchW(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("cache-control"), path).toBe(
      "private, max-age=60, stale-while-revalidate=60",
    );
    expect(res.headers.get("set-cookie"), path).toBeNull();
    expect(withoutNonce(res.headers.get("content-security-policy")), path).toBe(STRICT);
  }
  for (const path of [`${PAGED}?page=4`, "/tags/genre/x", "/tags/fandom/%21%21%21"]) {
    const res = await fetchW(path);
    expect(res.status, path).toBe(404);
    expect(res.headers.get("cache-control") ?? "", path).not.toMatch(/max-age/);
  }
}

describe("14-browse-and-home listing cache", () => {
  beforeAll(seedListings);

  it("Listings are briefly cached", async () => {
    await expectShortListingCache();
  });
});

describe("19-surge-controls-and-quotas", () => {
  beforeAll(seedListings);

  it("Listings use a short cache", async () => {
    await expectShortListingCache();
  });
});

/** Every card on the listings with ratings and warnings this file seeded. */
const allCards = async () => {
  const pages = await Promise.all(
    ["spelled%20out%20fandom", "long%20warnings%20fandom", "line%20order%20fandom"].map((n) =>
      htmlOf(`/tags/fandom/${n}`),
    ),
  );
  return pages.flatMap(cardsOf);
};

describe("20-site-chrome-and-legal", () => {
  it("Ratings and warnings are text, not symbols", async () => {
    const cards = await allCards();

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const line = lineOf(card, "card-rating") ?? "";
      expect(textOf(line)).toMatch(/^[\w ,·/-]+$/u);
      expect(line).not.toMatch(SYMBOLS);
    }
  });
});

describe("21-accessibility-and-no-js", () => {
  it("Colour is never the only signal", async () => {
    const cards = await allCards();
    const css = await stylesheetOf(await htmlOf("/tags/fandom/harry%20potter"));

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(lineOf(card, "card-rating")).toMatch(/^<strong>[^<]+<\/strong>$/);
      expect(card).not.toMatch(/style=|class="[^"]*(colou?r|red|green|amber)/);
    }
    expect(rulesFor(css, "card-rating")).not.toMatch(/color|background/);
  });
});
