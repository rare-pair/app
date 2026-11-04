import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { chapterPageKey, fragmentCacheKey } from "../src/edge-cache";
import { fetchW, signIn } from "./helpers";

// A signed-in or moderator header never reaches a shared cache (spec 20; spec 11, "Fresh
// nonce on edge-cached pages"). The only shared page entry is a chapter's, and it holds the
// parts before the layout: the header is added to each response, after the cache is read.
// AO3 work ids 42810 to 42829 are this file's; each test seeds a work of its own, since the
// Cache API keeps its entries from one test to the next. Addresses are synthetic.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

async function signInAs(email: string, role: string | null): Promise<string> {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role }).where("email", "=", email).execute();
  return cookie;
}

async function seedTwoChapters(ao3WorkId: number) {
  const w = await seedWork(db, {
    ao3WorkId,
    title: `nav old ${ao3WorkId}`,
    chapters: [{ html: "<p>nav one</p>" }, { html: "<p>nav two</p>" }],
  });
  await putFragments(env.BUCKET, w.fragments);
  return w;
}

const rename = (ao3WorkId: number) =>
  db
    .updateTable("works")
    .set({ title: `nav new ${ao3WorkId}` })
    .where("ao3_work_id", "=", ao3WorkId)
    .execute();

const kept = async (id: number, n: number) =>
  (await caches.default.match(chapterPageKey(id, n))) !== undefined;

const page = async (id: number, init: RequestInit = {}) =>
  (await fetchW(`/works/${id}/chapters/1`, init)).text();

const headerOf = (html: string) => html.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? "";

describe("20-site-chrome-and-legal: a signed-in header and shared caches", () => {
  it("A signed-in or moderator request never fills the edge page cache", async () => {
    const id = 42810;
    await seedTwoChapters(id);
    const user = await signInAs("nav-cache-fill-user@example.test", null);
    const moderator = await signInAs("nav-cache-fill-mod@example.test", "moderator");
    for (const cookie of [user, moderator]) {
      const html = await page(id, { headers: { cookie } });
      expect(html).toContain(`nav old ${id}`);
      expect(html).toContain('action="/logout"');
    }
    expect(await kept(id, 1)).toBe(false);
    await rename(id);
    // A fill by either would show the old title, and its header, to this signed-out request.
    const html = await page(id);
    expect(html).toContain(`nav new ${id}`);
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("/admin");
    expect(headerOf(html)).toContain("Sign in");
  });

  it("A signed-in request is never served from the edge page cache", async () => {
    const id = 42811;
    await seedTwoChapters(id);
    const user = await signInAs("nav-cache-hit-user@example.test", null);
    expect(await page(id)).toContain(`nav old ${id}`);
    expect(await kept(id, 1)).toBe(true);
    await rename(id);
    const own = await page(id, { headers: { cookie: user } });
    expect(own).toContain(`nav new ${id}`);
    expect(headerOf(own)).toContain("Sign out");
    // The signed-out reader still gets the kept page, with the signed-out header.
    const shared = await page(id);
    expect(shared).toContain(`nav old ${id}`);
    expect(headerOf(shared)).toContain("Sign in");
    expect(headerOf(shared)).not.toContain("Sign out");
  });

  it("A page kept from a signed-out request gets each reader's own header", async () => {
    const id = 42812;
    await seedTwoChapters(id);
    const moderator = await signInAs("nav-cache-own-mod@example.test", "moderator");
    expect(await page(id)).toContain(`nav old ${id}`);
    const html = await page(id, { headers: { cookie: moderator } });
    expect(headerOf(html)).toContain('href="/admin"');
    expect(headerOf(await page(id))).not.toContain("/admin");
  });

  it("The kept entry holds no header, sign-out form or admin link", async () => {
    const id = 42813;
    await seedTwoChapters(id);
    expect(await page(id)).toContain(`nav old ${id}`);
    const entry = await caches.default.match(chapterPageKey(id, 1));
    expect(entry).toBeDefined();
    const stored = await entry!.text();
    expect(stored).toContain(`nav old ${id}`);
    expect(stored).not.toMatch(/<header|Sign out|Sign in|\/admin|\/logout|\/me\/uploads/);
    const fragment = await caches.default.match(fragmentCacheKey(id, 1, (await versionOf(id))));
    if (fragment) expect(await fragment.text()).not.toMatch(/<header|Sign out|\/admin/);
  });

  it("A signed-in response is private and not stored, with a fresh nonce", async () => {
    const id = 42814;
    await seedTwoChapters(id);
    const user = await signInAs("nav-cache-headers@example.test", null);
    const first = await fetchW(`/works/${id}/chapters/1`, { headers: { cookie: user } });
    const second = await fetchW(`/works/${id}/chapters/1`, { headers: { cookie: user } });
    for (const res of [first, second]) {
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary") ?? "").not.toContain("*");
    }
    expect(first.headers.get("content-security-policy")).not.toBe(
      second.headers.get("content-security-policy"),
    );
  });
});

/** The id of the work's current version. */
async function versionOf(ao3WorkId: number): Promise<string> {
  const row = await db
    .selectFrom("works")
    .select("current_version_id")
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();
  return String(row.current_version_id);
}
