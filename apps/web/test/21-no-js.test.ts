import { createDb, insertUpload } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth";
import app from "../src/index";
import { BASE, emailsTo, freshIp, LOGIN_TOKEN, nonceOf, postLogin, signIn } from "./helpers";
import {
  attr,
  expectInOrder,
  forms,
  links,
  NoJsBrowser,
  scriptTags,
  type Page,
} from "./no-js-browser";

// One database serves every test file in the run, so this file keeps to AO3 work IDs
// 40800 to 40899, names every tag it seeds with a "nojs-" prefix and every email with
// "nojs-". Text is synthetic.
const GENERAL = 40800; // live, General Audiences, three chapters
const WARNED = 40801; // live, Mature: the warnings screen comes first
const HIDDEN = 40802;
const REMOVED = 40803;
const IMPERFECT = 40804; // live, with a review reason: the "may be imperfect" notice
const UNKNOWN = 40899; // no work has it

const NO_WARNINGS = { type: "warning" as const, name: "No Archive Warnings Apply" };
const rated = (name: string) => ({ type: "rating" as const, name });
const FANDOM = { type: "fandom" as const, name: "nojs-Fandom" };
const FREEFORM = { type: "freeform" as const, name: "nojs-Freeform" };

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const WORK = `/works/${GENERAL}`;
const CHAPTER = `${WORK}/chapters/1`;

/** The marker the seeded text of `id`'s chapter `n` carries. */
const textOf = (id: number, n: number) => `nojs-${id}-${n}`;

const cookies: Partial<Record<Who, string>> = {};
/** The path of a sign-in link nobody has opened, for the confirm page. */
let confirmPath = "";

type Who = "visitor" | "reader" | "newcomer" | "moderator";

/** Signs `email` in and gives the account `role`; `terms` says whether it accepted the terms. */
async function accountWith(email: string, role: string | null, terms: boolean) {
  const cookie = await signIn(email);
  await db
    .updateTable("user")
    .set({ role, terms_accepted_at: terms ? new Date() : null })
    .where("email", "=", email)
    .execute();
  return cookie;
}

beforeAll(async () => {
  const works = [
    { ao3WorkId: GENERAL, rating: "General Audiences", chapters: 3 },
    { ao3WorkId: WARNED, rating: "Mature", chapters: 2 },
    {
      ao3WorkId: HIDDEN,
      rating: "General Audiences",
      chapters: 2,
      status: "hidden" as const,
      hiddenCause: "moderator" as const,
    },
    { ao3WorkId: REMOVED, rating: "General Audiences", chapters: 2, status: "removed" as const },
    {
      ao3WorkId: IMPERFECT,
      rating: "General Audiences",
      chapters: 2,
      reviewReasons: ["missing_summary"],
    },
  ];
  for (const { chapters, rating, ...rest } of works) {
    const w = await seedWork(db, {
      ...rest,
      rating,
      title: `nojs work ${rest.ao3WorkId}`,
      tags: [rated(rating), NO_WARNINGS, FANDOM, FREEFORM],
      authors: [{ pseud: "nojs-pseud", ao3_user: "nojs-user" }],
      summary: "<p>nojs-summary</p>",
      chapters: Array.from({ length: chapters }, (_, i) => ({
        title: `nojs chapter ${i + 1}`,
        html: `<p>${textOf(rest.ao3WorkId, i + 1)}</p>`,
      })),
    });
    await putFragments(env.BUCKET, w.fragments);
  }

  cookies.reader = await accountWith("nojs-reader@example.test", null, true);
  cookies.newcomer = await accountWith("nojs-newcomer@example.test", null, false);
  cookies.moderator = await accountWith("nojs-moderator@example.test", "moderator", true);
  const email = "nojs-link@example.test";
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const [sent] = await emailsTo(email);
  const link = new URL(sent!.url);
  confirmPath = link.pathname + link.search;
});

describe("01-auth-magic-link", () => {
  it("Reading needs no account", async () => {
    const visitor = new NoJsBrowser();

    const home = await visitor.go("/");
    expect(home.res.status).toBe(200);
    expect(forms(home.html).map((f) => f.action)).not.toContain("/login");
    expect(home.html).not.toContain('name="email"');

    const work = await visitor.go(WORK);
    expect(work.res.status).toBe(200);
    expect(work.html).toContain(`nojs work ${GENERAL}`);

    const first = links(work.html).find((l) => l.href === CHAPTER);
    expect(first, "the work page links to its first chapter").toBeDefined();
    const chapter = await visitor.click(work, first!.href);
    expect(chapter.res.status).toBe(200);
    expect(chapter.path).toBe(CHAPTER);
    expect(chapter.html).toContain(textOf(GENERAL, 1));

    // No page asked them to sign in, and none gave them a session.
    expect(visitor.visited.some((p) => p.startsWith("/login"))).toBe(false);
    expect(visitor.cookies.has(SESSION_COOKIE)).toBe(false);
    for (const page of [home, work, chapter]) {
      expect(page.res.headers.getSetCookie().join("\n")).not.toContain(SESSION_COOKIE);
    }
  });

  it("A warned work's first page is its warnings screen, which needs no account either", async () => {
    const visitor = new NoJsBrowser();
    const target = `/works/${WARNED}/chapters/1`;
    const screen = await visitor.go(target);
    expect(screen.path).toBe(`/works/${WARNED}/warnings?next=${encodeURIComponent(target)}`);
    expect(screen.res.status).toBe(200);

    const [form] = forms(screen.html);
    const chapter = await visitor.submit(screen, form!);
    expect(chapter.path).toBe(target);
    expect(chapter.res.status).toBe(200);
    expect(chapter.html).toContain(textOf(WARNED, 1));
    expect(visitor.visited.some((p) => p.startsWith("/login"))).toBe(false);
    expect(visitor.cookies.has(SESSION_COOKIE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The inventory: every page of FRONTEND-DISCOVERY's table, as the Worker serves it.

interface Entry {
  name: string;
  path: string;
  who?: Who;
  status?: number;
  /** Sign in, upload, /remove and the copyright notice: the form hides until a nonced script shows it. */
  turnstile?: boolean;
  /** The enhancement scripts the page may carry, by file name before the hash. */
  scripts?: string[];
  /** What a reader meets, in order (CSS off). */
  order: string[];
  /** For a page that is not simply a path to open. */
  load?: () => Promise<Page>;
}

const CHROME = ['class="skip"', 'class="banner"', "<header>", '<main id="main">', "<h1"];
const CARD = [
  'class="card-title"',
  'class="card-byline"',
  'class="card-rating"',
  'class="card-summary"',
  'class="card-stats"',
];

const ENTRIES = (): Entry[] => [
  {
    name: "home",
    path: "/",
    order: [...CHROME, 'role="search"', "<h2>Popular fandoms", "<h2>Recently added"],
  },
  {
    name: "search results",
    path: "/search?q=nojs",
    order: [...CHROME, 'role="search"', 'class="work-list"', ...CARD],
  },
  {
    name: "tag listing",
    path: `/tags/fandom/${FANDOM.name}`,
    order: [...CHROME, 'class="listing-filters"', 'class="work-list"', ...CARD],
  },
  {
    name: "work page",
    path: WORK,
    order: [
      ...CHROME,
      'class="authors"',
      'class="rating-warnings"',
      'class="stats"',
      'class="chapters"',
      'class="full"',
      'class="report"',
      'class="remove"',
    ],
  },
  {
    name: "imperfect work page",
    path: `/works/${IMPERFECT}`,
    order: [...CHROME, 'class="rating-warnings"', 'class="review-notice"', 'class="chapters"'],
  },
  {
    name: "warnings screen",
    path: `/works/${WARNED}/warnings?next=${encodeURIComponent(`/works/${WARNED}/chapters/1`)}`,
    order: [
      ...CHROME,
      'class="work-title"',
      'class="rating"',
      "<form",
      "Continue",
      "Back to the work",
    ],
  },
  {
    name: "chapter",
    path: CHAPTER,
    scripts: ["reader-settings"],
    order: [
      'class="skip"',
      '<main id="main">',
      'class="reader-bar"',
      "<h1",
      "Reader settings",
      'class="chapter-nav"',
      'class="chapter-title"',
      '<article class="chapter"',
      'class="chapter-nav"',
    ],
  },
  {
    name: "chapter, signed in",
    path: CHAPTER,
    who: "reader",
    scripts: ["reader-settings", "reading-position"],
    order: ['class="reader-bar"', "<h1", 'class="chapter-nav"', '<article class="chapter"'],
  },
  {
    name: "imperfect chapter",
    path: `/works/${IMPERFECT}/chapters/1`,
    scripts: ["reader-settings"],
    order: [
      'class="reader-bar"',
      "<h1",
      'class="review-notice"',
      'class="chapter-nav"',
      '<article class="chapter"',
    ],
  },
  {
    name: "entire work",
    path: `${WORK}/full`,
    scripts: ["reader-settings"],
    order: [
      'class="reader-bar"',
      "<h1",
      'class="chapter-title"',
      '<article class="chapter"',
      'class="chapter-title"',
    ],
  },
  {
    name: "reader settings",
    path: `/settings/reader?next=${encodeURIComponent(CHAPTER)}`,
    scripts: ["reader-settings"],
    order: [...CHROME, "<form", "Save settings", "Back"],
  },
  {
    name: "sign in",
    path: "/login",
    turnstile: true,
    order: [...CHROME, "<noscript>", '<form id="sign-in"'],
  },
  {
    name: "confirm sign-in",
    path: "",
    load: () => new NoJsBrowser().go(confirmPath),
    order: [...CHROME, "<form"],
  },
  { name: "accept terms", path: "/welcome/terms", who: "newcomer", order: [...CHROME, "<form"] },
  {
    name: "sign out",
    path: "/logout",
    who: "reader",
    order: [...CHROME, 'action="/logout"', "Sign out"],
  },
  {
    name: "upload",
    path: "/upload",
    who: "reader",
    turnstile: true,
    scripts: ["upload"],
    order: [...CHROME, "<noscript>", 'id="upload"'],
  },
  { name: "my uploads", path: "/me/uploads", who: "reader", order: [...CHROME] },
  {
    name: "remove my work",
    path: "/remove",
    turnstile: true,
    order: [...CHROME, "<noscript>", 'id="remove"'],
  },
  {
    name: "remove confirm",
    path: `/remove/confirm?token=${"A".repeat(43)}`,
    order: [...CHROME, "<form"],
  },
  {
    name: "remove confirm, refused link",
    path: "/remove/confirm?token=short",
    status: 400,
    order: [...CHROME],
  },
  {
    name: "report",
    path: `${WORK}/report`,
    who: "reader",
    order: [...CHROME, "<fieldset>", "<legend>", "<textarea", "<button"],
  },
  {
    name: "copyright notice",
    path: "/dmca",
    turnstile: true,
    order: [...CHROME, "<noscript>", 'id="dmca"', "<button"],
  },
  { name: "moderation home", path: "/admin", who: "moderator", order: [...CHROME, "<nav"] },
  ...["reports", "takedowns", "requests", "works"].map((queue) => ({
    name: `${queue} queue`,
    path: `/admin/${queue}`,
    who: "moderator" as const,
    order: [...CHROME, "<nav", "<table", "<caption>", 'scope="col"'],
  })),
  { name: "about", path: "/about", order: [...CHROME] },
  { name: "terms", path: "/terms", order: [...CHROME] },
  { name: "privacy", path: "/privacy", order: [...CHROME] },
  ...[HIDDEN, REMOVED].flatMap((id) =>
    [`/works/${id}`, `/works/${id}/chapters/1`, `/works/${id}/full`].map((path) => ({
      name: `${id === HIDDEN ? "hidden" : "removed"} ${path}`,
      path,
      status: id === HIDDEN ? 451 : 410,
      order: [...CHROME],
    })),
  ),
  {
    name: "not found",
    path: `/works/${UNKNOWN}`,
    status: 404,
    order: [...CHROME, ">the home page</a>", 'role="search"'],
  },
  {
    name: "too many requests",
    path: "",
    status: 429,
    load: async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`${BASE}/search?q=nojs`, { headers: { "cf-connecting-ip": freshIp() } }),
        { ...env, SEARCH_IP_LIMIT: { limit: async () => ({ success: false }) } },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return { res, html: await res.text(), path: "/search?q=nojs" };
    },
    order: [...CHROME, "Please try again"],
  },
];

const opened = new Map<string, Page>();
/** Opens the entry once, as its reader would, and keeps the page. */
async function open(entry: Entry): Promise<Page> {
  const kept = opened.get(entry.name);
  if (kept) return kept;
  const browser = new NoJsBrowser();
  const cookie = cookies[entry.who ?? "visitor"];
  if (cookie) browser.withCookie(cookie);
  const page = entry.load ? await entry.load() : await browser.go(entry.path);
  opened.set(entry.name, page);
  return page;
}

/** Every opening tag of an element that carries the `hidden` attribute. */
const hiddenElements = (html: string) =>
  [...html.matchAll(/<[a-z][^>]*\shidden(?=[\s>=/])[^>]*>/gi)].map((m) => m[0]);

const SCRIPT_SRC = /^\/assets\/([a-z-]+)\.[0-9a-f]+\.js$/;
const byName = (a: string, b: string) => a.localeCompare(b);
/** The file names (before the hash) of the page's own scripts, sorted. */
const scriptNames = (srcs: string[]) =>
  srcs.flatMap((src) => SCRIPT_SRC.exec(src)?.[1] ?? []).sort(byName);
const INLINE_UNHIDE =
  /^<script nonce="[^"]*">document\.getElementById\("([\w-]+)"\)\.hidden = false;<\/script>$/;
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

describe("21-accessibility-and-no-js", () => {
  it("Pages render with JavaScript off and only the Turnstile forms need it", async () => {
    for (const entry of ENTRIES()) {
      const where = entry.name;
      const { res, html } = await open(entry);
      expect(res.status, where).toBe(entry.status ?? 200);
      expect(res.headers.get("content-type"), where).toMatch(/^text\/html/);
      // A whole page: a skip link first, one main, one h1.
      expect(html.startsWith("<!doctype html>"), where).toBe(true);
      expect(html, where).toContain('<html lang="en"');
      expect(html.match(/<main\b/g), where).toHaveLength(1);
      expect(html.match(/<h1\b/g), where).toHaveLength(1);
      expect(/<a\b[^>]*>/.exec(html)?.[0], where).toBe('<a class="skip" href="#main">');

      const hidden = hiddenElements(html);
      if (entry.turnstile) {
        // Without a script there is the message, and a form nothing could submit.
        expect(html, where).toMatch(/<noscript><p>[^<]*needs JavaScript[^<]*<\/p><\/noscript>/);
        const shown = /document\.getElementById\("([\w-]+)"\)\.hidden = false/.exec(html);
        expect(shown, `${where}: a script shows the form`).not.toBeNull();
        expect(hidden.join("\n"), where).toContain(`id="${shown![1]}"`);
      } else {
        // Nothing else needs a script to show it, nor a Turnstile check to send it.
        expect(html, where).not.toMatch(/cf-turnstile|challenges\.cloudflare\.com/);
        const noscript = html.replace(
          /<noscript><meta http-equiv="refresh"[^>]*><\/noscript>/g,
          "",
        );
        expect(noscript, where).not.toContain("<noscript");
        // The one hidden thing is the reader bar's live controls, with their link beside them.
        for (const tag of hidden) expect(tag, where).toContain('class="reader-settings"');
        if (hidden.length > 0) expect(html, where).toContain('href="/settings/reader?next=');
      }
    }
  });

  it("Scripts only enhance pages without a Turnstile check", async () => {
    for (const entry of ENTRIES()) {
      const where = entry.name;
      const { res, html } = await open(entry);
      const nonce = nonceOf(res.headers.get("content-security-policy"));
      expect(nonce, where).not.toBeNull();
      // No handler attribute, no javascript: link, no style: only nonced script elements.
      expect(html, where).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html, where).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
      for (const tag of scriptTags(html)) {
        expect(attr(tag, "nonce"), `${where}: ${tag}`).toBe(nonce);
      }

      const inline = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []).filter(
        (s) => attr(s.slice(7, s.indexOf(">")), "src") === null,
      );
      const srcs = scriptTags(html).flatMap((tag) => attr(tag, "src") ?? []);
      if (entry.turnstile) {
        // Turnstile runs the form: its script, the page's own where it has one, and one
        // inline line that shows the form.
        expect(srcs, where).toContain(TURNSTILE_SCRIPT);
        expect(inline, where).toHaveLength(1);
        expect(inline[0], where).toMatch(INLINE_UNHIDE);
        const own = srcs.filter((s) => s !== TURNSTILE_SCRIPT);
        expect(scriptNames(own), where).toEqual([...(entry.scripts ?? [])].sort(byName));
      } else {
        // Everywhere else a script is an external, nonced, deferred file that adds
        // reader settings, reading position or upload status, and nothing is inline.
        expect(inline, where).toHaveLength(0);
        expect(scriptNames(srcs), where).toEqual([...(entry.scripts ?? [])].sort(byName));
        for (const tag of scriptTags(html)) {
          expect(
            attr(tag, "defer") !== null || attr(tag, "async") !== null,
            `${where}: ${tag}`,
          ).toBe(true);
        }
      }
    }
  });

  it("Pages make sense with CSS off", async () => {
    for (const entry of ENTRIES()) {
      const where = entry.name;
      const { html } = await open(entry);
      // The HTML order is the reading order.
      expectInOrder(html, entry.order, where);
      // The footer closes the page, after everything it said.
      expect(html.indexOf("</main>"), where).toBeLessThan(html.indexOf("<footer>"));
      expect(html.lastIndexOf("<h1"), where).toBeLessThan(html.indexOf("</main>"));
      // Nothing that carries meaning by style or position.
      expect(html, where).not.toMatch(/<style\b|\sstyle\s*=/i);
      // Headings go down one level at a time, chapter text apart.
      const levels = [
        ...html
          .replace(/<article class="chapter"[^>]*>[\s\S]*?<\/article>/g, "")
          .matchAll(/<h([1-6])\b/g),
      ].map((m) => Number(m[1]));
      expect(levels[0], where).toBe(1);
      levels.forEach((level, i) => {
        if (i > 0)
          expect(level, `${where}: h${level} after h${levels[i - 1]}`).toBeLessThanOrEqual(
            levels[i - 1]! + 1,
          );
      });
    }
  });
});

describe("21-no-js journeys", () => {
  it("Finding and reading a work works with JavaScript off", async () => {
    const reader = new NoJsBrowser();
    const home = await reader.go("/");
    const search = forms(home.html).find((f) => f.action === "/search");
    expect(search, "the home page has a search form").toBeDefined();
    const results = await reader.submit(home, search!, { q: `nojs work ${GENERAL}` });
    expect(results.res.status).toBe(200);
    const hit = links(results.html).find((l) => l.href === WORK);
    expect(hit, "the results link to the work").toBeDefined();

    const work = await reader.click(results, hit!.href);
    expect(work.path).toBe(WORK);
    const chapter = await reader.click(
      work,
      links(work.html).find((l) => l.href === CHAPTER)!.href,
    );
    expect(chapter.html).toContain(textOf(GENERAL, 1));

    // The chapter's own form jumps to another chapter.
    const jump = forms(chapter.html).find((f) => f.action === `${WORK}/chapters`);
    expect(jump, "the chapter page has a chapter form").toBeDefined();
    const select = jump!.fields.find((f) => f.type === "select")!;
    const second = await reader.submit(chapter, jump!, { [select.name]: "2" });
    expect(second.path).toBe(`${WORK}/chapters/2`);
    expect(second.html).toContain(textOf(GENERAL, 2));

    const entire = await reader.click(
      work,
      links(work.html).find((l) => l.href === `${WORK}/full`)!.href,
    );
    for (const n of [1, 2, 3]) expect(entire.html).toContain(textOf(GENERAL, n));

    // A tag leads to a listing, whose own filter form still finds the work.
    const tag = links(work.html).find((l) => l.href.startsWith("/tags/"));
    expect(tag, "the work page links its tags").toBeDefined();
    const listing = await reader.click(work, tag!.href);
    expect(links(listing.html).map((l) => l.href)).toContain(WORK);
    const filter = forms(listing.html).find((f) => f.className === "listing-filters");
    expect(filter, "the listing has a filter form").toBeDefined();
    const filtered = await reader.submit(listing, filter!);
    expect(filtered.res.status).toBe(200);
    expect(links(filtered.html).map((l) => l.href)).toContain(WORK);
  });

  it("Reader settings work with JavaScript off", async () => {
    const reader = new NoJsBrowser();
    const chapter = await reader.go(CHAPTER);
    const link = links(chapter.html).find((l) => l.text === "Reader settings");
    expect(link, "the chapter has a settings link").toBeDefined();
    const page = await reader.click(chapter, link!.href);
    const form = forms(page.html).find((f) => f.method === "post" && !f.hidden);
    expect(form, "the settings page has a form").toBeDefined();
    const saved = await reader.submit(page, form!, { theme: "sepia" });
    // Back on the chapter, with the setting applied from the cookie.
    expect(saved.path).toBe(CHAPTER);
    expect(saved.html).toMatch(/<html[^>]*data-theme="sepia"/);
    expect(saved.html).toContain(textOf(GENERAL, 1));
  });

  it("Checking uploads works with JavaScript off", async () => {
    const email = "nojs-uploader@example.test";
    const cookie = await accountWith(email, null, true);
    const user = await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    const { id } = await insertUpload(db, {
      userId: user.id,
      r2Key: `uploads/${crypto.randomUUID()}`,
      bytes: 1234,
    });
    await db
      .updateTable("uploads")
      .set({ status: "processing", quota_counted_at: new Date() })
      .where("id", "=", id)
      .execute();

    const page = await new NoJsBrowser().withCookie(cookie).go("/me/uploads");
    expect(page.res.status).toBe(200);
    // The row, and the way it keeps itself fresh without a script.
    expect(page.html).toContain(`data-upload-id="${id}"`);
    expect(page.html).toMatch(/<noscript><meta http-equiv="refresh" content="\d+"><\/noscript>/);
    // Its one script is the external, nonced, in-place update.
    expect(scriptTags(page.html).map((t) => SCRIPT_SRC.exec(attr(t, "src") ?? "")?.[1])).toEqual([
      "my-uploads",
    ]);
  });

  it("Reporting a work works with JavaScript off", async () => {
    const reader = new NoJsBrowser().withCookie(cookies.reader!);
    const work = await reader.go(WORK);
    const link = links(work.html).find((l) => l.text === "Report");
    expect(link, "the work page links to the report form").toBeDefined();
    const page = await reader.click(work, link!.href);
    const form = forms(page.html).find((f) => f.action === `${WORK}/report`);
    expect(form, "the report page has a form").toBeDefined();
    const sent = await reader.submit(page, form!, { reason: "other", details: "nojs-details" });
    expect(sent.res.status).toBe(200);
    expect(sent.html).toContain("<h1>Report sent</h1>");
  });
});
