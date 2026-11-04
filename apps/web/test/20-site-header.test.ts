import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuth } from "../src/auth";
import { fetchW, headerOf, signIn } from "./helpers";

// Spec 20, the site header. AO3 work ids 42800 to 42899 are this file's. Addresses are
// synthetic, at @example.test.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs `email` in with the terms accepted and `role` set, and returns its cookie. */
async function signInAs(email: string, role: string | null = null): Promise<string> {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role }).where("email", "=", email).execute();
  return cookie;
}

/** The header's links as [text, href] pairs, in document order; href is null on a disabled one. */
const linksOf = (html: string) =>
  [...headerOf(html).matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].flatMap((m) =>
    m[2] === "rarepair" ? [] : [[m[2]!, m[1]!.match(/\bhref="([^"]*)"/)?.[1] ?? null] as const],
  );

const WORK = 42800;
const HIDDEN = 42801;
const REMOVED = 42802;
const HOSTILE = 42803;
const TAG = "nav-Fandom-42800";

beforeAll(async () => {
  const seeds: [number, Parameters<typeof seedWork>[1]][] = [
    [WORK, { tags: [{ type: "fandom", name: TAG }] }],
    [HIDDEN, { status: "hidden", hiddenCause: "moderator" }],
    [REMOVED, { status: "removed" }],
    [HOSTILE, { chapters: [{ html: '<p>one</p><header><a href="/x">hostile</a></header>' }, {}] }],
  ];
  for (const [id, extra] of seeds) {
    const w = await seedWork(db, { ao3WorkId: id, title: `nav work ${id}`, ...extra });
    await putFragments(env.BUCKET, w.fragments);
  }
});

/** Every kind of page the Worker answers, by path and status: the header goes on all of them. */
const PAGES: [string, number][] = [
  ["/", 200],
  ["/about", 200],
  ["/terms", 200],
  ["/privacy", 200],
  ["/login", 200],
  ["/logout", 200],
  ["/remove", 200],
  ["/dmca", 200],
  ["/search", 200],
  ["/search?q=nav", 200],
  ["/settings/reader", 200],
  ["/no-such-page", 404],
  [`/works/${WORK}`, 200],
  [`/works/${WORK}/chapters/1`, 200],
  [`/works/${WORK}/full`, 200],
  [`/works/${HIDDEN}`, 451],
  [`/works/${REMOVED}`, 410],
  [`/tags/fandom/${encodeURIComponent(TAG)}`, 200],
];

/** The one <header>, with one <nav> inside it. */
function expectOneHeader(html: string, label: string) {
  expect(html.match(/<header\b/g), label).toHaveLength(1);
  expect(html.match(/<header>/g), label).toHaveLength(1);
  expect(headerOf(html).match(/<nav\b/g), label).toHaveLength(1);
  expect(headerOf(html), label).toContain('<nav aria-label="Site">');
  expect(headerOf(html), label).not.toMatch(/<script|\sstyle=/);
}

describe("20-site-chrome-and-legal: the site header", () => {
  it("Every kind of page has the header for each kind of visitor", async () => {
    const signedIn = await signInAs("nav-table-user@example.test");
    const moderator = await signInAs("nav-table-mod@example.test", "moderator");
    for (const [path, status] of PAGES) {
      const out = await fetchW(path);
      expect(out.status, path).toBe(status);
      const outHtml = await out.text();
      expectOneHeader(outHtml, path);
      expect(
        linksOf(outHtml).map(([t]) => t),
        path,
      ).toEqual(["Add work", "Sign in"]);

      const inRes = await fetchW(path, { headers: { cookie: signedIn } });
      expect(inRes.status, path).toBe(status);
      const inHtml = await inRes.text();
      expectOneHeader(inHtml, path);
      expect(
        linksOf(inHtml).map(([t]) => t),
        path,
      ).toEqual(["Add work", "My uploads"]);
      expect(inHtml, path).toContain('action="/logout"');

      const modRes = await fetchW(path, { headers: { cookie: moderator } });
      const modHtml = await modRes.text();
      expectOneHeader(modHtml, path);
      expect(
        linksOf(modHtml).map(([t]) => t),
        path,
      ).toEqual(["Add work", "My uploads", "Admin"]);
      // No visitor's header goes on a page every visitor can be served.
      expect(headerOf(outHtml), path).not.toMatch(/Sign out|\/admin|My uploads/);
      expect(headerOf(inHtml), path).not.toMatch(/\/admin|Sign in/);
    }
  });

  it("The admin pages have the header, and a refusal is still a plain not-found", async () => {
    const moderator = await signInAs("nav-admin-pages@example.test", "moderator");
    const res = await fetchW("/admin", { headers: { cookie: moderator } });
    expect(res.status).toBe(200);
    expect(linksOf(await res.text()).map(([t]) => t)).toEqual(["Add work", "My uploads", "Admin"]);

    const user = await signInAs("nav-admin-refused@example.test");
    for (const cookie of [undefined, user]) {
      const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
      const refused = await fetchW("/admin", { headers });
      const missing = await fetchW("/no-such-page", { headers });
      expect(refused.status).toBe(404);
      expect(await refused.text()).toBe(await missing.text());
    }
  });

  it("A non-moderator never sees the Admin link, and a demoted moderator loses it on the next request", async () => {
    const email = "nav-demoted@example.test";
    const cookie = await signInAs(email, "moderator");
    const seen = async () =>
      linksOf(await (await fetchW("/about", { headers: { cookie } })).text());
    expect((await seen()).map(([t]) => t)).toContain("Admin");
    await db.updateTable("user").set({ role: null }).where("email", "=", email).execute();
    expect((await seen()).map(([t]) => t)).not.toContain("Admin");
    expect((await fetchW("/admin", { headers: { cookie } })).status).toBe(404);
    // A role that isn't a moderator's gives no link either.
    await db.updateTable("user").set({ role: "banned" }).where("email", "=", email).execute();
    expect((await seen()).map(([t]) => t)).not.toContain("Admin");
  });

  it("Nothing a client sends can set the role", async () => {
    const email = "nav-role-input@example.test";
    const cookie = await signInAs(email);
    const auth = makeAuth(env, db);
    // The session's own update, with the role in it: refused, or ignored. Either way the
    // row is unchanged. Better Auth's handler isn't mounted, so this is the route's only way in.
    // SAFETY: `role` is not in the update's typed body, because input: false removes it.
    const body = { name: "x", role: "admin" } as never;
    await auth.api.updateUser({ headers: new Headers({ cookie }), body }).catch(() => undefined);
    const row = await db
      .selectFrom("user")
      .select("role")
      .where("email", "=", email)
      .executeTakeFirst();
    expect(row?.role ?? null).toBeNull();
    const html = await (await fetchW("/about", { headers: { cookie } })).text();
    expect(linksOf(html).map(([t]) => t)).not.toContain("Admin");
    expect((await fetchW("/auth/update-user", { method: "POST" })).status).toBe(404);
  });

  it("A header in a chapter's text gets no navigation", async () => {
    for (const path of [`/works/${HOSTILE}/chapters/1`, `/works/${HOSTILE}/full`]) {
      const html = await (await fetchW(path)).text();
      expect(html, path).toContain("hostile");
      // The layout's header has the nav; the chapter's own does not.
      expect(html.match(/<nav aria-label="Site">/g), path).toHaveLength(1);
      expect(html.match(/<header\b/g), path).toHaveLength(2);
      const own = html.match(/<header><a href="\/x">hostile<\/a><\/header>/);
      expect(own, path).not.toBeNull();
    }
  });

  it("The header adds no script and posts only to /logout", async () => {
    const cookie = await signInAs("nav-markup@example.test", "moderator");
    const res = await fetchW("/about", { headers: { cookie } });
    const html = await res.text();
    const header = headerOf(html);
    expect(header).not.toMatch(/<script|\son[a-z]+=|\sstyle=/);
    expect(header.match(/\baction="([^"]*)"/g)).toEqual(['action="/logout"']);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // Reader privacy: no address or name in the page.
    expect(html).not.toContain("example.test");
  });

  it("Signed out, the header has Add work and Sign in", async () => {
    const html = await (await fetchW("/about")).text();
    expect(linksOf(html)).toEqual([
      ["Add work", "/upload"],
      ["Sign in", "/login"],
    ]);
    expect(headerOf(html)).not.toMatch(/<form|<button/);
  });

  it("Signed in, the header has Add work, My uploads and a Sign out form", async () => {
    const cookie = await signInAs("nav-user@example.test");
    const html = await (await fetchW("/about", { headers: { cookie } })).text();
    expect(linksOf(html)).toEqual([
      ["Add work", "/upload"],
      ["My uploads", "/me/uploads"],
    ]);
    const form = headerOf(html).match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toMatch(/<form\b(?=[^>]*\bmethod="post")(?=[^>]*\baction="\/logout")/);
    expect(form).toMatch(/<button\b[^>]*type="submit"[^>]*>Sign out<\/button>/);
    expect(headerOf(html)).not.toMatch(/\/admin|\/login/);
  });

  it("A moderator and an admin also get Admin, before Sign out", async () => {
    for (const role of ["moderator", "admin"]) {
      const cookie = await signInAs(`nav-${role}@example.test`, role);
      const html = await (await fetchW("/about", { headers: { cookie } })).text();
      expect(linksOf(html), role).toEqual([
        ["Add work", "/upload"],
        ["My uploads", "/me/uploads"],
        ["Admin", "/admin"],
      ]);
      expect(headerOf(html).indexOf("/admin"), role).toBeLessThan(
        headerOf(html).indexOf("Sign out"),
      );
    }
  });
});
