import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, REMOVE_TOKEN, signIn, WAITLIST_TOKEN } from "./helpers";

// One database serves every test file in the run, so this file keeps to AO3 work IDs
// 61400 to 61499, and every tag it seeds is named with a "cd-" prefix. Text is synthetic.
const W = 61401; // Mature, several warnings, two fandoms, a summary
const G = 61402; // General, a summary, no warnings
const NO_RATING = 61403; // no rating, no author, blank title
const HOSTILE = 61404;
const HIDDEN = 61405;
const REMOVED = 61406;
const MATURE_SUMMARY = "CD-MATURE-SUMMARY-MARKER";
const GENERAL_SUMMARY = "CD-GENERAL-SUMMARY-MARKER";
const NO_RATING_SUMMARY = "CD-UNRATED-SUMMARY-MARKER";
const QUERY_MARKER = "cd-query-marker";
const TAG_MARKER = "cd-tag-marker";
const TOKEN_MARKER = "cd-token-marker";

const SITE_DESCRIPTION = "An unofficial, temporary, community-run reading archive for fanworks.";
const PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uagent.php)";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const w = await seedWork(db, {
    ao3WorkId: W,
    title: "cd Work W",
    rating: "Mature",
    authors: [
      { pseud: "cd-Zed", ao3_user: "cd_zed" },
      { pseud: "cd-Amy", ao3_user: "cd_amy" },
    ],
    summary: `<p>${MATURE_SUMMARY}</p>`,
    tags: [
      { type: "rating", name: "cd-Mature" },
      { type: "warning", name: "cd-Graphic Violence" },
      { type: "warning", name: "cd-Major Character Death" },
      { type: "fandom", name: "cd-Fandom One" },
      { type: "fandom", name: "cd-Fandom Two" },
      { type: "freeform", name: TAG_MARKER },
    ],
    chapters: [
      { title: "cd one", html: "<p>cd text</p>" },
      { title: "cd two", html: "<p>cd text</p>" },
    ],
  });
  await putFragments(env.BUCKET, w.fragments);
  const g = await seedWork(db, {
    ao3WorkId: G,
    title: "cd Work G",
    rating: "General Audiences",
    authors: [{ pseud: "cd-Gee", ao3_user: "cd_gee" }],
    summary: `<p>${GENERAL_SUMMARY}</p>`,
    tags: [{ type: "fandom", name: "cd-Fandom One" }],
    chapters: [{ title: "cd one", html: "<p>cd text</p>" }],
  });
  await putFragments(env.BUCKET, g.fragments);
  await seedWork(db, {
    ao3WorkId: NO_RATING,
    title: "   ",
    rating: null,
    authors: [],
    summary: `<p>${NO_RATING_SUMMARY}</p>`,
    tags: [],
  });
  await seedWork(db, {
    ao3WorkId: HOSTILE,
    title: 'cd <script>alert(1)</script> "quoted"',
    authors: [{ pseud: 'cd <b onclick="x">pseud</b>', ao3_user: null }],
    tags: [
      { type: "rating", name: "cd-General Audiences" },
      { type: "warning", name: 'cd-Warn"><script>alert(2)</script>' },
      { type: "fandom", name: 'cd-Fandom"><script>alert(3)</script>' },
    ],
  });
  await seedWork(db, {
    ao3WorkId: HIDDEN,
    title: "CD-HIDDEN-TITLE",
    status: "hidden",
    hiddenCause: "moderator",
  });
  await seedWork(db, { ao3WorkId: REMOVED, title: "CD-REMOVED-TITLE", status: "removed" });
});

afterAll(() => db.destroy());

const metas = (html: string) =>
  [
    ...html.matchAll(
      /<meta\s+(?:property|name)="((?:og|twitter):[a-z_:]+)"\s+content="([^"]*)"\s*\/?>/g,
    ),
  ].map((m) => [m[1]!, m[2]!] as const);
const cardOf = (html: string) => Object.fromEntries(metas(html));
const hasCard = (html: string) => /<meta[^>]+(?:og|twitter):/.test(html);
const get = async (path: string, init: RequestInit = {}) => (await fetchW(path, init)).text();
const first = async (path: string, init: RequestInit = {}) => {
  const res = await fetchW(path, { ...init, redirect: "manual" });
  return res.status === 302 ? await get(res.headers.get("location")!, init) : await res.text();
};

describe("20-site-chrome-and-legal: cards", () => {
  it("A work page has a card", async () => {
    const card = cardOf(await get(`/works/${W}`));
    expect(card["og:title"]).toBe("cd Work W");
    expect(card["og:description"]).toBe(
      "by cd-Zed, cd-Amy · Mature · cd-Graphic Violence, cd-Major Character Death · cd-Fandom One, cd-Fandom Two",
    );
    expect(card["og:site_name"]).toBe("rarepair");
    expect(card["og:type"]).toBe("article");
    expect(card["og:url"]).toBe(`https://rarepair.fans/works/${W}`);
    expect(card["twitter:card"]).toBe("summary");
    expect(card["og:image"]).toBeUndefined();
    const plain = cardOf(await get(`/works/${NO_RATING}`));
    expect(plain["og:description"]).toBe("by Anonymous · Not Rated");
    expect(plain["og:title"]).toBe("Untitled work");
  });

  it("A work's card has no summary", async () => {
    for (const [id, marker] of [
      [W, MATURE_SUMMARY],
      [G, GENERAL_SUMMARY],
      [NO_RATING, NO_RATING_SUMMARY],
    ] as const) {
      const html = await get(`/works/${id}`);
      expect(html, String(id)).toContain(marker);
      expect(metas(html).flat().join("\n"), String(id)).not.toContain(marker);
    }
  });

  it("The other public pages share the site card", async () => {
    const tagPath = `/tags/freeform/${TAG_MARKER}`;
    for (const path of [
      "/",
      "/about",
      "/terms",
      "/privacy",
      "/remove",
      "/dmca",
      "/search",
      `/search?q=${QUERY_MARKER}`,
      tagPath,
      `${tagPath}?sort=updated&page=1`,
      "/tags/freeform/cd-no-such-tag",
    ]) {
      const html = await get(path);
      const card = cardOf(html);
      expect(card["og:title"], path).toBe("rarepair");
      expect(card["og:description"], path).toBe(SITE_DESCRIPTION);
      expect(card["og:site_name"], path).toBe("rarepair");
      expect(card["og:type"], path).toBe("website");
      expect(card["twitter:card"], path).toBe("summary");
      const text = metas(html).flat().join("\n");
      expect(text, path).not.toContain(QUERY_MARKER);
      expect(text, path).not.toContain(TAG_MARKER);
    }
  });

  it("Chapters have no card", async () => {
    for (const ua of ["Mozilla/5.0", PREVIEW_UA]) {
      const headers = { "user-agent": ua };
      for (const path of [
        `/works/${G}/chapters/1`,
        `/works/${G}/full`,
        `/works/${W}/chapters/1`,
        `/works/${W}/warnings`,
        `/works/${W}/full`,
        `/works/${W}/chapters`,
      ]) {
        expect(hasCard(await first(path, { headers })), `${path} ${ua}`).toBe(false);
      }
    }
  });

  it("A hidden or removed work has no card", async () => {
    for (const [id, status] of [
      [HIDDEN, 451],
      [REMOVED, 410],
    ] as const) {
      const res = await fetchW(`/works/${id}`);
      expect(res.status).toBe(status);
      const html = await res.text();
      expect(hasCard(html)).toBe(false);
      expect(html).not.toMatch(/CD-(HIDDEN|REMOVED)-TITLE/);
    }
  });

  it("A card never carries a token", async () => {
    const pages: string[] = [];
    for (const path of [
      "/login",
      `/login/confirm?token=${TOKEN_MARKER}`,
      `/remove/confirm?token=${TOKEN_MARKER}`,
      `/remove/confirm?token=${REMOVE_TOKEN}`,
      `/waitlist/confirm?token=${WAITLIST_TOKEN}`,
      `/waitlist/unsubscribe?token=${TOKEN_MARKER}`,
    ]) {
      const html = await first(path);
      expect(hasCard(html), path).toBe(false);
      pages.push(html);
    }
    pages.push(await get(`/works/${W}`), await get("/search?q=x&page=2"));
    for (const html of pages) {
      for (const [name, value] of metas(html)) {
        if (name === "og:url") expect(value).not.toContain("?");
        expect(value).not.toContain(TOKEN_MARKER);
      }
    }
  });

  it("A card's text is escaped", async () => {
    const html = await get(`/works/${HOSTILE}`);
    const tags = html.match(/<meta[^>]+(?:og|twitter):[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(5);
    for (const tag of tags) {
      expect(tag).toMatch(/^<meta\s+(?:property|name)="[a-z:_]+"\s+content="[^"<>]*"\s*\/?>$/);
    }
    const card = cardOf(html);
    expect(card["og:title"]).toBe("cd &lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot;");
    expect(card["og:description"]).toContain("cd &lt;b onclick=&quot;x&quot;&gt;pseud&lt;/b&gt;");
    expect(card["og:description"]).toContain("cd-Warn&quot;&gt;&lt;script&gt;");
    expect(card["og:description"]).toContain("cd-Fandom&quot;&gt;&lt;script&gt;");
  });

  it("Admin pages and signed-in pages show no account or moderation detail in a card", async () => {
    const email = "cd-moderator@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    await db.updateTable("user").set({ role: "moderator" }).where("email", "=", email).execute();
    const headers = { cookie };
    for (const path of ["/", `/works/${W}`]) {
      const signedIn = await get(path, { headers });
      expect(cardOf(signedIn), path).toEqual(cardOf(await get(path)));
      expect(metas(signedIn).flat().join("\n"), path).not.toContain(email);
    }
    for (const path of ["/admin", "/admin/reports", "/me/uploads", "/settings/reader"]) {
      const res = await fetchW(path, { headers, redirect: "manual" });
      expect(hasCard(await res.text()), path).toBe(false);
    }
  });

  it("A link preview service that identifies itself gets the work page's card", async () => {
    const browser = cardOf(await get(`/works/${W}`));
    expect(Object.keys(browser)).toContain("og:title");
    for (const headers of [
      { "user-agent": PREVIEW_UA },
      { "user-agent": "Mozilla/5.0", "signature-agent": '"https://preview.example"' },
    ]) {
      expect(cardOf(await get(`/works/${W}`, { headers }))).toEqual(browser);
    }
  });
});
