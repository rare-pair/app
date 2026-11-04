import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Work ID 41050 is this file's alone.
const W = 41050;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const seeded = await seedWork(db, {
    ao3WorkId: W,
    chapters: [
      { title: "A11y one", html: "<p>A11Y-1</p>" },
      { title: "A11y two", html: "<p>A11Y-2</p>" },
      { title: " ", html: "<p>A11Y-3</p>" },
    ],
  });
  await putFragments(env.BUCKET, seeded.fragments);
});
afterAll(async () => {
  await db.destroy();
});

describe("Skip link, landmarks and one h1", () => {
  it("Each chapter article on the entire-work page is named by its chapter heading", async () => {
    const res = await fetchW(`/works/${W}/full`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const articles = [...html.matchAll(/<article class="chapter"( aria-labelledby="([^"]*)")?>/g)];
    expect(articles.map((a) => a[2])).toEqual(["chapter-1", "chapter-2", "chapter-3"]);
    const titles = articles.map(([, , id = ""]) => {
      expect(html.match(new RegExp(`id="${id}"`, "g")), id).toHaveLength(1);
      return html.match(new RegExp(`<h2 class="chapter-title" id="${id}">([^<]*)</h2>`))?.[1];
    });
    expect(titles).toEqual(["A11y one", "A11y two", "Chapter 3"]);
  });
});
