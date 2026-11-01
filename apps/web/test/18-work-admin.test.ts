import { createDb } from "@archive/db";
import { putFragments, seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, emailsTo, fetchW, LOGIN_TOKEN, postLogin } from "./helpers";

// One database serves every test file in the run. This file keeps to AO3 work IDs
// 14200 to 14299 and gives every marker a "mod4-" prefix. Text is synthetic.
const W = 14200;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** A copy of 18-moderation.test.ts's `signIn`: A4 (#24) brings the shared one to helpers.ts. */
async function signIn(email: string, role: string | null): Promise<string> {
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const [sent] = await emailsTo(email);
  const token = new URL(sent!.url).searchParams.get("token")!;
  const res = await postLogin({ token, next: "/" }, { url: "/login/confirm" });
  expect(res.status).toBe(303);
  await db
    .updateTable("user")
    .set({ role, terms_accepted_at: new Date() })
    .where("email", "=", email)
    .execute();
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

const get = (path: string, cookie?: string) =>
  fetchW(path, { headers: cookie === undefined ? {} : { cookie } });

/** A form post as the site's own page makes it. */
const post = (path: string, cookie?: string, fields: Record<string, string> = {}) => {
  const headers = new Headers({
    origin: BASE,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (cookie !== undefined) headers.set("cookie", cookie);
  return fetchW(path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};

const currentOf = async (ao3WorkId: number) =>
  (
    await db
      .selectFrom("works")
      .select("current_version_id")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirstOrThrow()
  ).current_version_id;

let moderator: string;
let plainUser: string;
let v1: string;
let v2: string;
let heldId: string;
let otherV: string;
let uploaderEmail: string;

beforeAll(async () => {
  moderator = await signIn("mod4-moderator@example.test", "moderator");
  plainUser = await signIn("mod4-user@example.test", null);
  // W: v1 replaced by v2 (current), and a third held for review, with 3, 2 and 4 chapters.
  const seeded = await seedWork(db, {
    ao3WorkId: W,
    title: "mod4-title",
    chapters: [
      { html: "<p>mod4-v1-one</p>" },
      { html: "<p>mod4-v1-two</p>" },
      { html: "<p>mod4-v1-three</p>" },
    ],
    addedAt: "2001-01-01T00:00:00Z",
  });
  v1 = seeded.versionId;
  const second = await seedVersion(db, seeded, {
    chapters: [{ html: "<p>mod4-v2-one</p>" }, { html: "<p>mod4-v2-two</p>" }],
    addedAt: "2001-02-01T00:00:00Z",
  });
  v2 = second.versionId;
  const held = await seedVersion(db, seeded, {
    current: false,
    chapters: 4,
    addedAt: "2001-03-01T00:00:00Z",
  });
  heldId = held.versionId;
  await putFragments(env.BUCKET, [...seeded.fragments, ...second.fragments]);
  const user = await db
    .selectFrom("user")
    .select("email")
    .where("id", "=", seeded.userId)
    .executeTakeFirstOrThrow();
  uploaderEmail = user.email;
  const other = await seedWork(db, { ao3WorkId: W + 1, title: "mod4-other" });
  otherV = other.versionId;
});

describe("08 versioning and dedupe", () => {
  it("Work admin page lists every version", async () => {
    const res = await get(`/admin/works/${W}`, moderator);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    const rows = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
    const row = (date: string) => rows.find((r) => r.includes(date)) ?? "";
    for (const [date, chapters] of [
      ["2001-01-01", "3"],
      ["2001-02-01", "2"],
    ] as const) {
      expect(row(date), date).toContain(uploaderEmail);
      expect(row(date), date).toContain(`<td>${chapters}</td>`);
    }
    const [first, second, held] = [row("2001-01-01"), row("2001-02-01"), row("2001-03-01")];
    expect(first).toContain(`name="version" value="${v1}"`);
    expect(first).toContain(`action="/admin/works/${W}/current"`);
    expect(second).toContain(`name="version" value="${v2}"`);
    // Held for review: listed, but only an approval makes it current.
    expect(held).toContain("<td>4</td>");
    expect(held).not.toContain("<form");
    expect(rows.indexOf(first)).toBeLessThan(rows.indexOf(second));
  });

  it("A moderator rolls back a bad replacement", async () => {
    expect(await currentOf(W)).toBe(v2);
    expect(await (await get(`/works/${W}/chapters/1`)).text()).toContain("mod4-v2-one");
    const res = await post(`/admin/works/${W}/current`, moderator, { version: v1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await currentOf(W)).toBe(v1);
    const chapter = await (await get(`/works/${W}/chapters/3`)).text();
    expect(chapter).toContain("mod4-v1-three");
    expect(await (await get(`/works/${W}/chapters/1`)).text()).not.toContain("mod4-v2-one");
  });

  it("Make current refuses a held version and another work's version", async () => {
    const before = await currentOf(W);
    const held = await post(`/admin/works/${W}/current`, moderator, { version: heldId });
    expect(held.status).toBe(200);
    expect(await held.text()).toContain("held for review");
    for (const version of [otherV, "mod4-no-such-version", "mod4\0nul", "", "x".repeat(65)]) {
      const res = await post(`/admin/works/${W}/current`, moderator, { version });
      expect(res.status, version).toBe(404);
    }
    expect((await post(`/admin/works/${W}/current`, moderator)).status).toBe(404);
    expect((await post("/admin/works/14299/current", moderator, { version: v2 })).status).toBe(404);
    expect(await currentOf(W)).toBe(before);
    expect(await currentOf(W + 1)).toBe(otherV);
  });

  it("Make current works while the work is hidden, and not once it is removed", async () => {
    await db
      .updateTable("works")
      .set({ status: "hidden", hidden_cause: "moderator" })
      .where("ao3_work_id", "=", W)
      .execute();
    expect((await post(`/admin/works/${W}/current`, moderator, { version: v2 })).status).toBe(200);
    expect(await currentOf(W)).toBe(v2);
    await db
      .updateTable("works")
      .set({ status: "removed", hidden_cause: null })
      .where("ao3_work_id", "=", W)
      .execute();
    const res = await post(`/admin/works/${W}/current`, moderator, { version: v1 });
    expect(await res.text()).toContain("removed");
    expect(await currentOf(W)).toBe(v2);
    await db.updateTable("works").set({ status: "live" }).where("ao3_work_id", "=", W).execute();
  });

  it("Only moderators can roll back", async () => {
    const before = await currentOf(W);
    const target = before === v1 ? v2 : v1;
    for (const cookie of [plainUser, undefined]) {
      expect((await get(`/admin/works/${W}`, cookie)).status).toBe(404);
      const res = await post(`/admin/works/${W}/current`, cookie, { version: target });
      expect(res.status).toBe(404);
    }
    // A moderator's post from another site gets the same answer.
    const crossSite = await fetchW(`/admin/works/${W}/current`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
        cookie: moderator,
      },
      body: new URLSearchParams({ version: target }).toString(),
    });
    expect(crossSite.status).toBe(404);
    expect(await currentOf(W)).toBe(before);
  });

  it("An unknown work has no admin page", async () => {
    expect((await get("/admin/works/14299", moderator)).status).toBe(404);
    expect((await get("/admin/works/nope", moderator)).status).toBe(404);
  });
});
