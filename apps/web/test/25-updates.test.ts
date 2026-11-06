import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeHtml, homePage } from "../src/home";
import app from "../src/index";
import { type Update, UPDATES } from "../src/updates-data";
import { BASE, fetchW, signIn, STRICT, withoutNonce } from "./helpers";

// Runs in the "open" project; 25-updates.prelaunch.test.ts has the cases with PRELAUNCH on.
// This file keeps to AO3 work IDs 8812900 to 8812909. Text is synthetic.
const SEEDED = 8812900;
const FIRST = "release-0-1-0-chuhura";
const CRAWLER = "Mozilla/5.0 (compatible; GPTBot/1.3; +https://openai.com/gptbot)";
const BRANDING = /AO3|OTW|Archive of Our Own|Organization for Transformative Works/i;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
beforeAll(async () => {
  await seedWork(db, {
    ao3WorkId: SEEDED,
    title: "Updates Test Work",
    tags: [{ type: "fandom", name: "Updates Test Fandom" }],
  });
});
afterAll(() => db.destroy());

const update = (slug: string, created: string, more: Partial<Update> = {}): Update => ({
  slug,
  title: `Title ${slug}`,
  summary: `Summary of ${slug}`,
  author: "admin",
  created,
  body: `<p>Body of ${slug}</p>`,
  ...more,
});
const A = update("a", "2026-01-01");
const B = update("b", "2026-01-02");
const C = update("c", "2026-01-03");
const D = update("d", "2026-01-04");

/** The home page with `list` as its updates, and the real database behind it. */
async function home(list: readonly Update[]) {
  const ctx = createExecutionContext();
  const html = await homePage(env, ctx, list);
  await waitOnExecutionContext(ctx);
  return html;
}

/** Everything between the first `<main>` and its end. */
const mainOf = (html: string) => html.match(/<main[^>]*>([\s\S]*)<\/main>/)?.[1] ?? "";

describe("25-updates", () => {
  it("The home page shows the latest updates, newest first", async () => {
    const html = await home([A, B, C, D]);
    const at = (slug: string) => html.indexOf(`href="/updates/${slug}"`);
    expect(html).toContain("<h2>Updates</h2>");
    const [d, c, b, a] = ["d", "c", "b", "a"].map(at);
    expect(d).toBeGreaterThan(-1);
    expect(d).toBeLessThan(c!);
    expect(c).toBeLessThan(b!);
    expect(a).toBe(-1);
    expect(html).not.toContain("Title a");
  });

  it("Fewer than three updates", async () => {
    const html = await home(UPDATES.filter((u) => u.slug === FIRST));
    expect(html).toContain(`href="/updates/${FIRST}"`);
    expect(html.match(/<li class="update">/g)).toHaveLength(1);
  });

  it("No updates", async () => {
    const html = await home([]);
    expect(html).not.toContain("Updates</h2>");
    expect(html).not.toContain("update-list");
  });

  it("Where the section sits", async () => {
    const html = await home([A]);
    const search = html.indexOf('role="search"');
    const updates = html.indexOf("<h2>Updates</h2>");
    expect(search).toBeGreaterThan(-1);
    expect(updates).toBeGreaterThan(search);
    expect(html.indexOf("<h2>Popular fandoms</h2>")).toBeGreaterThan(updates);
    expect(html.indexOf("<h2>Recently added</h2>")).toBeGreaterThan(updates);
  });

  it("Updates show when the archive is empty", () => {
    const html = homeHtml({ fandoms: [], works: [], updates: [A] });
    const updates = html.indexOf("<h2>Updates</h2>");
    expect(updates).toBeGreaterThan(-1);
    expect(html.indexOf("There are no works here yet.")).toBeGreaterThan(updates);
  });

  it("What a summary card shows", async () => {
    const html = await home([B]);
    expect(html).toContain('<a href="/updates/b">Title b</a>');
    expect(html).toContain("Summary of b");
    expect(html).toContain("admin");
    expect(html).toContain('<time datetime="2026-01-02">2026-01-02</time>');
    expect(html).not.toContain("Body of b");
  });

  it("No list page yet", async () => {
    expect((await home(UPDATES)).toLowerCase()).not.toContain("all updates");
    const res = await fetchW("/updates");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page not found");
  });

  it("Text is escaped", async () => {
    const odd = update("odd", "2026-02-01", {
      title: `rarepair v0.1.0 "Chuhura" & <b>friends</b>`,
      summary: `Q&A with "quotes" and <script>x</script>`,
      author: `a & <i>b</i>`,
    });
    const card = await home([odd]);
    expect(card).toContain("rarepair v0.1.0 &quot;Chuhura&quot; &amp; &lt;b&gt;friends&lt;/b&gt;");
    expect(card).not.toContain("<b>friends</b>");
    expect(card).not.toContain("<script>x</script>");

    const { updatePage } = await import("../src/updates");
    const post = updatePage("odd", [odd]) ?? "";
    expect(post).toContain(
      "<h1>rarepair v0.1.0 &quot;Chuhura&quot; &amp; &lt;b&gt;friends&lt;/b&gt;</h1>",
    );
    expect(post).toContain(
      "<title>rarepair v0.1.0 &quot;Chuhura&quot; &amp; &lt;b&gt;friends&lt;/b&gt; · rarepair</title>",
    );
    expect(post).toContain(
      'content="rarepair v0.1.0 &quot;Chuhura&quot; &amp; &lt;b&gt;friends&lt;/b&gt;"',
    );
    expect(post).toContain("Q&amp;A with &quot;quotes&quot; and &lt;script&gt;x&lt;/script&gt;");
    expect(post).not.toContain("<i>b</i>");
  });

  it("What a post shows", async () => {
    const res = await fetchW(`/updates/${FIRST}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    const main = mainOf(html);
    const first = UPDATES.find((u) => u.slug === FIRST)!;
    expect(main.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("<h1>rarepair v0.1.0 &quot;Chuhura&quot;</h1>");
    const at = (text: string) => main.indexOf(text);
    expect(at("<h1>")).toBeLessThan(at("rarepair is open. It is a temporary"));
    expect(at("rarepair is open. It is a temporary")).toBeLessThan(at("admin and 🤖"));
    expect(at("admin and 🤖")).toBeLessThan(at('<time datetime="2026-11-06">2026-11-06</time>'));
    expect(at('<time datetime="2026-11-06">')).toBeLessThan(at("TLDR; ⚡"));
    expect(main).toContain(first.body);
    expect(html).toContain('<a class="skip" href="#main">');
    expect(html).toContain('<aside class="banner"');
    expect(html).toContain("<footer>");
    expect(html).not.toContain("this text has not been proofread yet");
  });

  it("The post is static", async () => {
    const dead = new Proxy(
      {},
      {
        get() {
          throw new Error("the post read a binding");
        },
      },
    );
    const ctx = createExecutionContext();
    // SAFETY: the stand-in is only ever handed to the Worker, which must not touch it.
    const stood: Partial<typeof env> = {
      HYPERDRIVE: dead as never,
      HYPERDRIVE_CACHED: dead as never,
      BUCKET: dead as never,
      POSITIONS: dead as never,
    };
    const res = await app.fetch(
      new Request(new URL(`/updates/${FIRST}`, BASE)),
      { ...env, ...stood },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const about = await fetchW("/about");
    expect(res.headers.get("cache-control")).toBe(about.headers.get("cache-control"));

    const cookie = await signIn("updates-static@example.test", { acceptTerms: true });
    const signedIn = await fetchW(`/updates/${FIRST}`, { headers: { cookie } });
    expect(signedIn.status).toBe(200);
    const signedOut = await fetchW(`/updates/${FIRST}`);
    expect(mainOf(await signedIn.text())).toBe(mainOf(await signedOut.text()));
  });

  it("A post works without JavaScript", async () => {
    const html = await (await fetchW(`/updates/${FIRST}`)).text();
    expect(html).not.toContain("<script");
    const homeHtmlText = await home(UPDATES);
    expect(homeHtmlText).not.toContain("<script");
  });

  it("A post meets the page rules", async () => {
    const res = await fetchW(`/updates/${FIRST}`);
    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
    const body = UPDATES.find((u) => u.slug === FIRST)!.body;
    expect(body).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i);
    expect(body).not.toMatch(/javascript:/i);
  });

  it("Branding holds in the first update", async () => {
    const html = await (await fetchW(`/updates/${FIRST}`)).text();
    expect(html).not.toMatch(BRANDING);
  });

  it("An unknown slug is not found", async () => {
    for (const slug of ["nope", "constructor", "__proto__", "toString"]) {
      const res = await fetchW(`/updates/${slug}`);
      expect(res.status, slug).toBe(404);
      expect(await res.text(), slug).toContain("Page not found");
    }
  });

  it("Terms gate applies as on the home page", async () => {
    const cookie = await signIn("updates-terms@example.test");
    const res = await fetchW(`/updates/${FIRST}`, { headers: { cookie } });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "", BASE);
    expect(location.pathname).toBe("/welcome/terms");
    expect(location.searchParams.get("next")).toBe(`/updates/${FIRST}`);
  });

  it("Bots are refused posts too", async () => {
    const res = await fetchW(`/updates/${FIRST}`, { headers: { "user-agent": CRAWLER } });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Automated access to this site isn't allowed");
    expect(html).not.toContain("TLDR");
  });

  it("A post has a link card", async () => {
    const html = await (await fetchW(`/updates/${FIRST}`)).text();
    const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
    const first = UPDATES.find((u) => u.slug === FIRST)!;
    expect(head).toContain('<meta property="og:type" content="article">');
    expect(head).toContain(
      '<meta property="og:title" content="rarepair v0.1.0 &quot;Chuhura&quot;">',
    );
    expect(head).toContain(`<meta property="og:description" content="${first.summary}">`);
    expect(head).toContain(
      `<meta property="og:url" content="https://rarepair.fans/updates/${FIRST}">`,
    );
    expect(head).toContain('<meta name="twitter:card" content="summary">');
    expect(head).not.toContain("TLDR");
    expect(head).not.toContain("I am hoping");
  });
});
