import { createDb } from "@archive/db";
import { putFragments, seedWork, type SeedChapter } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRICT, TURNSTILE, fetchW, nonceOf, withoutNonce } from "./helpers";

// Every work here has an AO3 work ID in 21000-21999 and tags named r4-..., so no other
// test file sharing the database sees them. Text is synthetic markers only.
const W = 21001;
const TITLE = `R4 <b>entire</b> & "work"`;
const TITLE_ESCAPED = "R4 &lt;b&gt;entire&lt;/b&gt; &amp; &quot;work&quot;";
const TAGS = [
  { type: "rating" as const, name: "r4-General Audiences" },
  { type: "fandom" as const, name: "r4-Fandom" },
];

// Work W's five chapters.
const CHAPTERS: SeedChapter[] = [
  { title: "R4 one", html: "<p>R4-W-1-TEXT</p>" },
  { title: "R4 <i>two</i>", html: "<p>R4-W-2-TEXT</p>" },
  // A chapter with no title of its own.
  { title: " ", html: "<p>R4-W-3-TEXT</p>" },
  // Test only: a script that got past the sanitizer, and a heading of the chapter's own.
  {
    title: "R4 four",
    html: "<h1>R4-W-4-HEADING</h1><p>R4-W-4-TEXT</p><script>window.R4 = 1</script>",
  },
  { title: "R4 five", html: "<p>R4-W-5-TEXT</p>" },
];

/** Live, with review reasons no moderator has cleared. */
const F = 21002;
/** Live, with review reasons a moderator has cleared. */
const CHECKED = 21003;
/** No fragment in R2 at all. */
const MISSING_FIRST = 21004;
/** Chapters 1 and 2 in R2, chapter 3 not. */
const MISSING_LATER = 21005;
/** Live, but its version's chapter rows are gone: a corrupt row ingest never writes. */
const NO_CHAPTERS = 21008;
/** Chapter 3's row points outside the version's fragments, at an object that exists. */
const BAD_KEY = 21009;
const BAD_KEY_TARGET = `originals/${BAD_KEY}.epub`;
/** A blank title, and an empty fragment between two others. */
const EDGE = 21010;
/** 60 chapters. */
const LONG = 21006;
/** One chapter of several MB, multi-byte characters throughout. */
const BIG = 21007;
const BIG_HTML = `<p>${"é🙂ü".repeat(500_000)}</p>`;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

// R2 writes go in beforeAll: isolated storage undoes those made inside an `it`.
beforeAll(async () => {
  const w = await seedWork(db, { ao3WorkId: W, title: TITLE, tags: TAGS, chapters: CHAPTERS });
  await putFragments(env.BUCKET, w.fragments);
  for (const ao3WorkId of [F, CHECKED]) {
    const seeded = await seedWork(db, {
      ao3WorkId,
      reviewReasons: ["missing_rating"],
      tags: TAGS,
      chapters: [1, 2, 3].map((n) => ({ html: `<p>R4-${ao3WorkId}-${n}-TEXT</p>` })),
    });
    await putFragments(env.BUCKET, seeded.fragments);
    if (ao3WorkId === CHECKED) {
      await db
        .updateTable("work_versions")
        .set({ checked_at: new Date().toISOString() })
        .where("id", "=", seeded.versionId)
        .execute();
    }
  }
  await seedWork(db, { ao3WorkId: MISSING_FIRST, tags: TAGS, chapters: 2 });
  const empty = await seedWork(db, { ao3WorkId: NO_CHAPTERS, tags: TAGS, chapters: 1 });
  await db.deleteFrom("chapters").where("version_id", "=", empty.versionId).execute();
  const edge = await seedWork(db, {
    ao3WorkId: EDGE,
    title: "  ",
    tags: TAGS,
    chapters: [{ html: "<p>R4-EDGE-1</p>" }, { html: "" }, { html: "<p>R4-EDGE-3</p>" }],
  });
  await putFragments(env.BUCKET, edge.fragments);
  const bad = await seedWork(db, {
    ao3WorkId: BAD_KEY,
    tags: TAGS,
    chapters: [1, 2, 3].map((n) => ({ html: `<p>R4-BAD-${n}-TEXT</p>` })),
  });
  await putFragments(env.BUCKET, [...bad.fragments, { key: BAD_KEY_TARGET, body: "R4-ORIGINAL" }]);
  await db
    .updateTable("chapters")
    .set({ r2_key: BAD_KEY_TARGET })
    .where("version_id", "=", bad.versionId)
    .where("n", "=", 3)
    .execute();
  const later = await seedWork(db, {
    ao3WorkId: MISSING_LATER,
    tags: TAGS,
    chapters: [1, 2, 3].map((n) => ({ html: `<p>R4-LATER-${n}-TEXT</p>` })),
  });
  await putFragments(env.BUCKET, later.fragments.slice(0, 2));
  const long = await seedWork(db, {
    ao3WorkId: LONG,
    tags: TAGS,
    chapters: Array.from({ length: 60 }, (_, i) => ({ html: `<p>R4-LONG-${i + 1}</p>` })),
  });
  await putFragments(env.BUCKET, long.fragments);
  const big = await seedWork(db, { ao3WorkId: BIG, tags: TAGS, chapters: [{ html: BIG_HTML }] });
  await putFragments(env.BUCKET, big.fragments);
});

afterAll(() => db.destroy());

const fullUrl = (id: number | string) => `/works/${id}/full`;
const chapterUrl = (id: number, n: number) => `/works/${id}/chapters/${n}`;

const HSTS = "max-age=31536000; includeSubDomains";

/** An empty, uncached 503 with HSTS and no page: no HTML, so no policy either. */
const expectUnavailable = async (path: string) => {
  const res = await fetchW(path);
  expect(res.status, path).toBe(503);
  expect(res.headers.get("cache-control"), path).toBe("no-store");
  expect(res.headers.get("strict-transport-security"), path).toBe(HSTS);
  expect(res.headers.get("content-type"), path).toBeNull();
  expect(await res.text(), path).toBe("");
};

const NOTICE = `<p class="review-notice">Chapters may be imperfect; a moderator will check.</p>`;

const htmlOf = async (path: string) => {
  const res = await fetchW(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

/** Every chapter article's markup, in page order. */
const articlesOf = (html: string) =>
  [
    ...html.matchAll(
      /<article class="chapter" aria-labelledby="chapter-[0-9]+">([\s\S]*?)<\/article>/g,
    ),
  ].map(([, a = ""]) => a);

/** A response body's chunks as they arrive, into `into`, which keeps them if it fails. */
const readChunks = async (res: Response, into: Uint8Array[] = []) => {
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return into;
    into.push(value);
  }
};

describe("11-reader-and-csp", () => {
  it("Entire work on one page", async () => {
    const res = await fetchW(fullUrl(W));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    // Set after the handler, on a body that is still streaming.
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    const html = await res.text();
    // Every chapter, each in its own article, in order.
    const articles = articlesOf(html);
    expect(articles).toEqual([
      "<p>R4-W-1-TEXT</p>",
      "<p>R4-W-2-TEXT</p>",
      "<p>R4-W-3-TEXT</p>",
      "<h1>R4-W-4-HEADING</h1><p>R4-W-4-TEXT</p><script>window.R4 = 1</script>",
      "<p>R4-W-5-TEXT</p>",
    ]);
    // Each under its own heading, escaped, with a stable anchor; no title is its number.
    const headings = [
      ...html.matchAll(
        /<h2 class="chapter-title" id="chapter-(\d+)">([^<]*)<\/h2>\n<article class="chapter" aria-labelledby="chapter-\1">/g,
      ),
    ].map(([, n, title]) => [n, title]);
    expect(headings).toEqual([
      ["1", "R4 one"],
      ["2", "R4 &lt;i&gt;two&lt;/i&gt;"],
      ["3", "Chapter 3"],
      ["4", "R4 four"],
      ["5", "R4 five"],
    ]);
    // The slim bar: the work title is the one chrome h1; the chapter's own h1 is content.
    const chrome = articles.reduce((page, a) => page.replace(a, ""), html);
    expect(chrome.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g)).toEqual([`<h1>${TITLE_ESCAPED}</h1>`]);
    // The settings link comes back to the entire work (R5).
    expect(chrome).toMatch(
      new RegExp(
        `<div class="reader-bar"><h1>[^<]*</h1><a href="/settings/reader\\?next=%2Fworks%2F${W}%2Ffull">`,
      ),
    );
    // No chapter select, no frame, no epub engine, no summary; a way back to the work. The
    // bar's selects are the reader settings' (R5), not a chapter select.
    expect(html).not.toMatch(/<nav class="chapter-nav"|<iframe/i);
    const settingsForm = chrome.match(/<form class="reader-settings"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(chrome.replace(settingsForm, "")).not.toMatch(/<select/i);
    for (const article of articles) expect(article).not.toMatch(/<select/i);
    expect(html).not.toContain("A seeded summary");
    expect(chrome.slice(chrome.lastIndexOf("</article>"))).toContain(`<a href="/works/${W}">`);
  });

  it("Reader pages show the may-be-imperfect notice", async () => {
    // Two of F's chapters and its entire work: once each, as chrome, never inside a chapter.
    for (const path of [chapterUrl(F, 1), chapterUrl(F, 3), fullUrl(F)]) {
      const html = await htmlOf(path);
      expect(html.split(NOTICE), path).toHaveLength(2);
      for (const article of articlesOf(html)) expect(article, path).not.toContain("review-notice");
      // Under the bar, before the chapter nav and the text.
      const at = html.indexOf(NOTICE);
      expect(at, path).toBeGreaterThan(html.indexOf('<div class="reader-bar">'));
      expect(at, path).toBeLessThan(html.search(/<nav|<h2 class="chapter-title"/));
    }
    // No notice for a work without review reasons, or once a moderator has checked it.
    for (const path of [chapterUrl(W, 1), fullUrl(W), chapterUrl(CHECKED, 2), fullUrl(CHECKED)]) {
      expect(await htmlOf(path), path).not.toContain("review-notice");
    }
  });

  it("Reader and work pages never allow third-party frames", async () => {
    // W's entire work streams chapter 4's injected script: the header still holds.
    for (const path of [`/works/${W}`, chapterUrl(W, 2), chapterUrl(W, 4), fullUrl(W)]) {
      const res = await fetchW(path);
      expect(res.status, path).toBe(200);
      const csp = res.headers.get("content-security-policy");
      // Exactly the strict policy: no frame-src, so no frame of any origin.
      expect(withoutNonce(csp), path).toBe(STRICT);
      expect(csp, path).not.toMatch(/frame-src|challenges\.cloudflare\.com/);
      await res.body?.cancel();
    }
    // The control: a Turnstile page does carry the frame allowance.
    const login = await fetchW("/login");
    expect(withoutNonce(login.headers.get("content-security-policy"))).toBe(TURNSTILE);
    await login.body?.cancel();
  });
});

// Not scenario cases: the orchestrator's rulings for /full, and what streaming promises.
describe("entire work", () => {
  it("An unknown work or a malformed ID is the not-found page", async () => {
    // 2147483647 is the largest ID the database can hold: a well-formed miss.
    for (const id of [
      "21999",
      "2147483647",
      "0",
      "021001",
      "abc",
      "2147483648",
      "1e3",
      "%2B21001",
    ]) {
      const res = await fetchW(fullUrl(id));
      expect(res.status, id).toBe(404);
      // The site's one not-found answer, uncached like every 404.
      expect(res.headers.get("cache-control"), id).toBe("no-store");
      const html = await res.text();
      expect(html, id).toContain("<h1>Page not found</h1>");
      expect(html, id).not.toContain('<article class="chapter"');
    }
  });

  it("Each entire-work response has its own nonce", async () => {
    const [a, b] = await Promise.all([fetchW(fullUrl(W)), fetchW(fullUrl(W))]);
    const [na, nb] = [a, b].map((res) => nonceOf(res.headers.get("content-security-policy")));
    expect(na).toBeTruthy();
    expect(nb).toBeTruthy();
    expect(na).not.toBe(nb);
    await Promise.all([a.body?.cancel(), b.body?.cancel()]);
  });

  it("A first chapter whose fragment is missing is an empty, uncached 503", async () => {
    await expectUnavailable(fullUrl(MISSING_FIRST));
  });

  it("A live work with no chapters is an empty, uncached 503", async () => {
    await expectUnavailable(fullUrl(NO_CHAPTERS));
  });

  it("A chapter key outside the version's fragments is a 503 before any chapter is sent", async () => {
    // Chapters 1 and 2 are readable, but chapter 3's row names an original: every key is
    // checked before the page starts, so nothing of the work goes out.
    await expectUnavailable(fullUrl(BAD_KEY));
  });

  it("HEAD answers with the page's headers and no body", async () => {
    const res = await fetchW(fullUrl(W), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
    expect(await res.text()).toBe("");
  });

  it("A later fragment that is missing ends the page in an error", async () => {
    // The 200 is out before chapter 3 is read: the stream errors, so no cache keeps a
    // truncated page that looks whole.
    const res = await fetchW(fullUrl(MISSING_LATER));
    expect(res.status).toBe(200);
    const seen: Uint8Array[] = [];
    await expect(readChunks(res, seen)).rejects.toBeInstanceOf(Error);
    const html = await new Blob(seen).text();
    expect(html).toContain("R4-LATER-2-TEXT");
    expect(html).not.toContain("</main>");
  });

  it("An untitled work and an empty chapter still make a whole page", async () => {
    const html = await htmlOf(fullUrl(EDGE));
    expect(html).toContain("<title>Untitled work, entire work · rarepair</title>");
    expect(html).toContain('<div class="reader-bar"><h1>Untitled work</h1>');
    expect(articlesOf(html)).toEqual(["<p>R4-EDGE-1</p>", "", "<p>R4-EDGE-3</p>"]);
    expect(html).toContain("</main>");
  });

  it("A work of 60 chapters comes out whole and in order", async () => {
    const articles = articlesOf(await (await fetchW(fullUrl(LONG))).text());
    expect(articles).toEqual(Array.from({ length: 60 }, (_, i) => `<p>R4-LONG-${i + 1}</p>`));
  });

  it("A large fragment streams in chunks and keeps its bytes", async () => {
    const chunks = await readChunks(await fetchW(fullUrl(BIG)));
    expect(chunks.length).toBeGreaterThan(2);
    const html = await new Blob(chunks).text();
    expect(articlesOf(html)).toEqual([BIG_HTML]);
  });

  it("The entire work streams the same for a reader with settings", async () => {
    // A settings cookie sends the page through the settings rewriter (R5), which must
    // keep each promise above: HEAD has no body, a missing chapter still errors the
    // stream, and a large fragment still arrives in chunks with its bytes.
    const headers = { cookie: "__Host-reader=theme=dark" };
    const head = await fetchW(fullUrl(W), { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const missing = await fetchW(fullUrl(MISSING_LATER), { headers });
    expect(missing.status).toBe(200);
    const seen: Uint8Array[] = [];
    await expect(readChunks(missing, seen)).rejects.toBeInstanceOf(Error);
    const partial = await new Blob(seen).text();
    expect(partial).toContain("R4-LATER-2-TEXT");
    expect(partial).not.toContain("</main>");

    const chunks = await readChunks(await fetchW(fullUrl(BIG), { headers }));
    expect(chunks.length).toBeGreaterThan(2);
    const html = await new Blob(chunks).text();
    expect(html).toMatch(/^<!doctype html>\n<html lang="en" data-theme="dark">/);
    expect(articlesOf(html)).toEqual([BIG_HTML]);
  });
});
