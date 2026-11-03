import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Work IDs 41000-41049 and tag names starting "A11y" are this file's alone: one
// database serves every test file in the project, and a listing sees whatever
// shares its tag.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(async () => {
  await db.destroy();
});

const htmlOf = async (path: string) => {
  const res = await fetchW(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

/** The card that links to this work, or "" when the page has none. */
const cardOf = (html: string, ao3WorkId: number) =>
  html
    .split(/<li><article class="work-card">/)
    .slice(1)
    .map((card) => card.slice(0, card.indexOf("</article></li>")))
    .find((card) => card.includes(`href="/works/${ao3WorkId}"`)) ?? "";

const lineOf = (card: string, className: string) =>
  card.match(new RegExp(`<(p|div) class="${className}">([\\s\\S]*?)</\\1>`))?.[2] ?? null;

/** The card summary's inner HTML (it may hold divs, so not `lineOf`). */
const summaryOf = (card: string) =>
  card.match(/<div class="card-summary">([\s\S]*?)<\/div>\n<p class="card-more">/)?.[1] ?? "";

const hidden = (label: string) => `<span class="visually-hidden">${label}: </span>`;

describe("Tag types are announced without colour", () => {
  it("Each tag on a card carries its type as a hidden label inside its link", async () => {
    await seedWork(db, {
      ao3WorkId: 41001,
      tags: [
        { type: "fandom", name: "A11y Labels Fandom" },
        { type: "relationship", name: "A11y Ann/Bea" },
        { type: "character", name: "A11y Ann" },
        { type: "freeform", name: "A11y Fluff" },
      ],
    });
    // Characters only, the case the issue describes.
    await seedWork(db, {
      ao3WorkId: 41002,
      tags: [
        { type: "fandom", name: "A11y Labels Fandom" },
        { type: "character", name: "A11y Cy" },
        { type: "character", name: "A11y Di" },
      ],
    });

    const html = await htmlOf("/tags/fandom/a11y%20labels%20fandom");

    const full = cardOf(html, 41001);
    expect(lineOf(full, "card-fandoms")).toBe(
      `<a href="/tags/fandom/a11y%20labels%20fandom">${hidden("Fandom")}A11y Labels Fandom</a>`,
    );
    const tags = lineOf(full, "card-tags") ?? "";
    expect(tags).toContain(
      `<a href="/tags/relationship/a11y%20ann%2Fbea">${hidden("Relationship")}A11y Ann/Bea</a>`,
    );
    expect(tags).toContain(
      `<a href="/tags/character/a11y%20ann">${hidden("Character")}A11y Ann</a>`,
    );
    // The count of other tags is plain text.
    expect(tags).toContain(" · 1 other tag");
    expect(tags.match(/visually-hidden/g)).toHaveLength(2);

    const characters = lineOf(cardOf(html, 41002), "card-tags") ?? "";
    expect(characters).toBe(
      `<a href="/tags/character/a11y%20cy">${hidden("Character")}A11y Cy</a>, <a href="/tags/character/a11y%20di">${hidden("Character")}A11y Di</a>`,
    );
  });

  it("A tag name with markup or non-ASCII text is escaped beside its label", async () => {
    await seedWork(db, {
      ao3WorkId: 41004,
      tags: [
        { type: "fandom", name: "A11y Escape Fandom" },
        { type: "character", name: `A11y <b>"Zoë" & 'Ño'</b>` },
      ],
    });

    const html = await htmlOf("/tags/fandom/a11y%20escape%20fandom");

    const tags = lineOf(cardOf(html, 41004), "card-tags") ?? "";
    expect(tags).toContain(
      `${hidden("Character")}A11y &lt;b&gt;&quot;Zoë&quot; &amp; &#39;Ño&#39;&lt;/b&gt;</a>`,
    );
    expect(tags).not.toContain("<b>");
    const listing = await htmlOf(
      `/tags/character/${encodeURIComponent(`a11y <b>"zoë" & 'ño'</b>`)}`,
    );
    expect(listing).toContain("(character)</h1>");
    expect(listing).not.toContain("<b>");
  });

  it("A tag shown without a link is labelled too", async () => {
    await seedWork(db, {
      ao3WorkId: 41003,
      tags: [
        { type: "fandom", name: "A11y Labels Fandom" },
        { type: "character", name: "???" },
      ],
    });

    const html = await htmlOf("/tags/fandom/a11y%20labels%20fandom");

    expect(lineOf(cardOf(html, 41003), "card-tags")).toBe(`${hidden("Character")}???`);
  });
});

describe("A clamped summary holds no focusable link", () => {
  it("Links in a card summary are text; the more link is the only one after it", async () => {
    await seedWork(db, {
      ao3WorkId: 41010,
      summary:
        '<p>See <a href="https://elsewhere.example/">elsewhere here</a>.</p><p><a href="https://elsewhere.example/two"><img src="https://img.example/x.png" alt="A11y alt"></a></p>',
      tags: [{ type: "fandom", name: "A11y Links Fandom" }],
    });

    const card = cardOf(await htmlOf("/tags/fandom/a11y%20links%20fandom"), 41010);

    const summary = summaryOf(card);
    expect(summary).not.toContain("<a");
    expect(summary).toContain("See elsewhere here.");
    expect(summary).toContain('alt="A11y alt"');
    const afterSummary = card.slice(card.indexOf('class="card-more"'));
    expect(afterSummary).toContain('<a href="/works/41010" aria-label="more of ');
    // The title, the fandom and the more link are the only links in the card.
    expect(card.match(/<a\b/g)).toHaveLength(3);
  });
});

describe("Skip link, landmarks and one h1", () => {
  const SUMMARY =
    "<h1>A11y Big</h1><p>Intro</p><h2>A11y Small</h2><li>A11y stray</li><ul><li>A11y kept</li></ul>";

  it("A summary's headings never add a heading to a card, and its stray item is not a li", async () => {
    await seedWork(db, {
      ao3WorkId: 41020,
      summary: SUMMARY,
      tags: [{ type: "fandom", name: "A11y Headings Fandom" }],
    });

    const html = await htmlOf("/tags/fandom/a11y%20headings%20fandom");

    const summary = summaryOf(cardOf(html, 41020));
    expect(summary).not.toMatch(/<h[1-6]/);
    expect(summary).toContain('<div class="summary-heading"><strong>A11y Big</strong></div>');
    expect(summary).toContain("<div>A11y stray</div>");
    expect(summary).toContain("<ul><li>A11y kept</li></ul>");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it("A summary's headings never add a second h1 to the work page", async () => {
    await seedWork(db, { ao3WorkId: 41022, summary: SUMMARY });

    const html = await htmlOf("/works/41022");

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h[2-6]\b/);
    expect(html).toContain('<div class="summary-heading"><strong>A11y Big</strong></div>');
    expect(html).toContain("<div>A11y stray</div>");
    expect(html).toContain("<ul><li>A11y kept</li></ul>");
  });

  it("A work page keeps links in its summary", async () => {
    await seedWork(db, {
      ao3WorkId: 41021,
      summary: '<p><a href="https://elsewhere.example/">kept link</a></p>',
    });

    expect(await htmlOf("/works/41021")).toContain(
      '<a href="https://elsewhere.example/">kept link</a>',
    );
  });
});

describe("Tag listing heading names the type", () => {
  it("The same name as a fandom and as a character reads differently", async () => {
    await seedWork(db, { ao3WorkId: 41030, tags: [{ type: "fandom", name: "A11y Same Name" }] });
    await seedWork(db, { ao3WorkId: 41031, tags: [{ type: "character", name: "A11y Same Name" }] });

    const fandom = await htmlOf("/tags/fandom/a11y%20same%20name");
    const character = await htmlOf("/tags/character/a11y%20same%20name");

    expect(fandom).toContain("<h1>A11y Same Name (fandom)</h1>");
    expect(fandom).toContain("<title>A11y Same Name (fandom) · ");
    expect(character).toContain("<h1>A11y Same Name (character)</h1>");
    expect(character).toContain("<title>A11y Same Name (character) · ");
  });

  it("The name is still escaped, and a freeform tag says additional tag", async () => {
    await seedWork(db, {
      ao3WorkId: 41032,
      tags: [{ type: "relationship", name: "A11y Kirk & Spock" }],
    });
    await seedWork(db, { ao3WorkId: 41033, tags: [{ type: "freeform", name: "A11y Plain" }] });

    expect(await htmlOf("/tags/relationship/a11y%20kirk%20%26%20spock")).toContain(
      "<h1>A11y Kirk &amp; Spock (relationship)</h1>",
    );
    expect(await htmlOf("/tags/freeform/a11y%20plain")).toContain(
      "<h1>A11y Plain (additional tag)</h1>",
    );
  });
});
