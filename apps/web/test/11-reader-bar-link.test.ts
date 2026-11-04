import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { chapterPageKey } from "../src/edge-cache";
import { fetchW, headerOf, signIn } from "./helpers";

// Scenario 11, the reader bar: the work's title links to the work page, on a chapter, on
// /full and on a chapter served from the edge cache. AO3 work ids 43800 to 43899 are this
// file's. Addresses are synthetic, at @example.test.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const PLAIN = 43800;
const HOSTILE = 43801;
const UNTITLED = 43802;
const CACHED = 43803;

const HOSTILE_TITLE = `nav2 <b>"quoted"</b> & more`;
const HOSTILE_ESCAPED = "nav2 &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &amp; more";

async function seed(ao3WorkId: number, title: string) {
  const w = await seedWork(db, { ao3WorkId, title, chapters: [{}, {}] });
  await putFragments(env.BUCKET, w.fragments);
}

/** The reader bar's markup: what sits between the bar's div and the first closing div. */
const barOf = (html: string) => html.match(/<div class="reader-bar">([\s\S]*?)<\/div>/)?.[1] ?? "";

/** The link inside the bar's h1: its href and its text. */
const titleLinkOf = (html: string) => {
  const m = barOf(html).match(/<h1><a href="([^"]*)">([^<]*)<\/a><\/h1>/);
  return m ? { href: m[1]!, text: m[2]! } : null;
};

describe("11-reader-and-csp: the work title in the reader bar", () => {
  it("A chapter's title links to the work page", async () => {
    await seed(PLAIN, `nav2 plain ${PLAIN}`);
    const html = await (await fetchW(`/works/${PLAIN}/chapters/2`)).text();
    expect(titleLinkOf(html)).toEqual({ href: `/works/${PLAIN}`, text: `nav2 plain ${PLAIN}` });
    // One h1, still the work's title; the link takes a reader to the work page.
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const work = await fetchW(`/works/${PLAIN}`);
    expect(work.status).toBe(200);
    expect(await work.text()).toContain(`<h1>nav2 plain ${PLAIN}</h1>`);
  });

  it("The entire work's title links to the work page", async () => {
    const html = await (await fetchW(`/works/${PLAIN}/full`)).text();
    expect(titleLinkOf(html)).toEqual({ href: `/works/${PLAIN}`, text: `nav2 plain ${PLAIN}` });
    expect(barOf(html)).toContain('<a href="/settings/reader?next=%2Fworks%2F43800%2Ffull">');
  });

  it("A title with markup is escaped inside the link", async () => {
    await seed(HOSTILE, HOSTILE_TITLE);
    for (const path of [`/works/${HOSTILE}/chapters/1`, `/works/${HOSTILE}/full`]) {
      const html = await (await fetchW(path)).text();
      expect(titleLinkOf(html), path).toEqual({
        href: `/works/${HOSTILE}`,
        text: HOSTILE_ESCAPED,
      });
      expect(html, path).not.toContain('<b>"quoted"</b>');
    }
  });

  it("A work with no title links as Untitled work", async () => {
    await seed(UNTITLED, "   ");
    for (const path of [`/works/${UNTITLED}/chapters/1`, `/works/${UNTITLED}/full`]) {
      const html = await (await fetchW(path)).text();
      expect(titleLinkOf(html), path).toEqual({
        href: `/works/${UNTITLED}`,
        text: "Untitled work",
      });
    }
  });

  it("A chapter served from the edge cache has the link, and the entry holds no signed-in state", async () => {
    await seed(CACHED, `nav2 cached ${CACHED}`);
    const url = `/works/${CACHED}/chapters/1`;
    // A moderator's request neither reads nor fills the entry.
    const email = "nav2-bar-mod@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    await db.updateTable("user").set({ role: "moderator" }).where("email", "=", email).execute();
    const signedInHtml = await (await fetchW(url, { headers: { cookie } })).text();
    expect(titleLinkOf(signedInHtml)).not.toBeNull();
    expect(await caches.default.match(chapterPageKey(CACHED, 1))).toBeUndefined();

    // A signed-out reader fills it; the next is served from it, after the title changed.
    await fetchW(url);
    expect(await caches.default.match(chapterPageKey(CACHED, 1))).toBeDefined();
    await db
      .updateTable("works")
      .set({ title: "nav2 renamed" })
      .where("ao3_work_id", "=", CACHED)
      .execute();
    const hit = await (await fetchW(url)).text();
    expect(hit).toContain(`nav2 cached ${CACHED}`);
    expect(hit).not.toContain("nav2 renamed");
    expect(titleLinkOf(hit)).toEqual({
      href: `/works/${CACHED}`,
      text: `nav2 cached ${CACHED}`,
    });
    expect(headerOf(hit)).not.toMatch(/Sign out|\/admin|My uploads/);

    const stored = await caches.default.match(chapterPageKey(CACHED, 1));
    const entry = await stored!.text();
    expect(entry).toContain(`<a href=\\"/works/${CACHED}\\">`);
    expect(entry).not.toMatch(/logout|Sign out|\/admin|My uploads|example\.test|aria-label=\\"Site/);
  });
});
