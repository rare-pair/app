import { createDb, insertUpload } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, fetchW, postLogin, signIn as signInAs, UPLOAD_TOKEN } from "./helpers";

// MOD6's cases: a moderator bans an uploader from a work's admin page. One database serves
// every test file in the run. This file keeps to AO3 work IDs 14400 to 14499 and gives every
// account and marker a "mod6-" prefix. Text is synthetic.
const W = 14400;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs `email` in, accepting the terms, with `role`; returns its id and session cookie. */
async function signIn(email: string, role: string | null = null) {
  const cookie = await signInAs(email, { acceptTerms: true });
  const user = await db
    .updateTable("user")
    .set({ role })
    .where("email", "=", email)
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: user.id, cookie };
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

const ban = (userId: string, cookie: string | undefined, from = `/admin/works/${W}`) =>
  post(`/admin/users/${encodeURIComponent(userId)}/ban`, cookie, { from });

const bannedAt = async (userId: string) =>
  (
    await db
      .selectFrom("user")
      .select("banned_at")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow()
  ).banned_at;

const logFor = (userId: string) =>
  db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id", "note"])
    .where("target_id", "=", userId)
    .execute();

const statusOf = async (uploadId: string) =>
  (
    await db
      .selectFrom("uploads")
      .select("status")
      .where("id", "=", uploadId)
      .executeTakeFirstOrThrow()
  ).status;

const uploadsOf = (userId: string) =>
  db.selectFrom("uploads").select("id").where("user_id", "=", userId).execute();

/** A pending upload by `userId`, as `POST /uploads` leaves it, with its object stored. */
async function pendingUpload(userId: string) {
  const id = crypto.randomUUID();
  const key = `uploads/${id}`;
  await insertUpload(db, { id, userId, r2Key: key, bytes: 64 });
  await env.BUCKET.put(key, crypto.getRandomValues(new Uint8Array(64)));
  return id;
}

let moderator: { id: string; cookie: string };

beforeAll(async () => {
  moderator = await signIn("mod6-moderator@example.test", "moderator");
});

describe("18-moderation", () => {
  it("Moderator bans an uploader", async () => {
    // GIVEN uploader Z with live uploads, and one still pending.
    const z = await signIn("mod6-z@example.test");
    const work = await seedWork(db, { ao3WorkId: W, title: "mod6-title", userId: z.id });
    const pending = await pendingUpload(z.id);
    const page = await (await get(`/admin/works/${W}`, moderator.cookie)).text();
    expect(page).toContain(`action="/admin/users/${z.id}/ban"`);
    expect(page).toContain(`name="from" value="/admin/works/${W}"`);

    // WHEN M uses the ban uploader action
    const res = await ban(z.id, moderator.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const done = await res.text();
    expect(done).toContain("The uploader is banned.");
    expect(done).toContain(`href="/admin/works/${W}"`);

    // THEN Z's `banned_at` is set, and the ban is logged with its moderator.
    expect(await bannedAt(z.id)).toBeInstanceOf(Date);
    expect(await logFor(z.id)).toEqual([
      {
        moderator_id: moderator.id,
        action: "ban",
        target_kind: "user",
        target_id: z.id,
        note: null,
      },
    ]);
    // The work page shows the uploader banned, with no button.
    const after = await (await get(`/admin/works/${W}`, moderator.cookie)).text();
    expect(after).not.toContain(`action="/admin/users/${z.id}/ban"`);
    expect(after).toContain("Banned");

    // AND Z can no longer upload: not asking, not confirming, not shown the form.
    const before = (await uploadsOf(z.id)).length;
    const asked = await postLogin(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { url: "/uploads", headers: { cookie: z.cookie } },
    );
    expect(asked.status).toBe(403);
    expect(asked.headers.get("cache-control")).toBe("no-store");
    expect(await asked.json()).toEqual({ error: "This account can't upload." });
    expect(await uploadsOf(z.id)).toHaveLength(before);
    // A batch is refused whole: no row for any of its files.
    const batch = await postLogin(
      {},
      {
        url: "/uploads",
        headers: { cookie: z.cookie },
        body: new URLSearchParams([
          ["size", "1000"],
          ["size", "2000"],
          ["cf-turnstile-response", UPLOAD_TOKEN],
        ]).toString(),
      },
    );
    expect(batch.status).toBe(403);
    expect(await batch.json()).toEqual({ error: "This account can't upload." });
    expect(await uploadsOf(z.id)).toHaveLength(before);
    // A row written after the ban (one a request in flight had passed its check for).
    const late = await pendingUpload(z.id);
    const confirmed = await postLogin(
      {},
      { url: `/uploads/${late}/complete`, headers: { cookie: z.cookie } },
    );
    expect(confirmed.status).toBe(403);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect(await confirmed.json()).toEqual({ error: "This account can't upload." });
    // Ended as the ban ends every pending upload, so it never sits "not uploaded yet".
    expect(await statusOf(late)).toBe("account_banned");
    const form = await get("/upload", z.cookie);
    expect(form.status).toBe(403);
    expect(form.headers.get("cache-control")).toBe("no-store");
    const formHtml = await form.text();
    expect(formHtml).toContain("This account can't upload.");
    expect(formHtml).not.toContain("<form");

    // AND Z can no longer report.
    const report = await postLogin(
      { reason: "other" },
      { url: `/works/${W}/report`, headers: { cookie: z.cookie } },
    );
    expect(report.status).toBe(403);
    expect(await report.text()).toContain("You can't send reports from this account.");

    // AND Z's live work and finished upload stay; the pending one ends account_banned.
    expect((await get(`/works/${W}`)).status).toBe(200);
    expect(await statusOf(work.uploadId)).toBe("live");
    expect(await statusOf(pending)).toBe("account_banned");
    const polled = await get(`/uploads/${pending}`, z.cookie);
    expect(await polled.json()).toEqual({ id: pending, status: "account_banned", work: null });
  });

  it("A second ban changes nothing", async () => {
    const y = await signIn("mod6-again@example.test");
    expect((await ban(y.id, moderator.cookie)).status).toBe(200);
    const first = await bannedAt(y.id);

    const res = await ban(y.id, moderator.cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing changed: the uploader is already banned.");
    expect(await bannedAt(y.id)).toEqual(first);
    expect(await logFor(y.id)).toHaveLength(1);
  });

  it("A moderator can't ban themselves, another moderator or an admin", async () => {
    const other = await signIn("mod6-other-moderator@example.test", "moderator");
    const admin = await signIn("mod6-admin@example.test", "admin");
    for (const target of [moderator, other, admin]) {
      const res = await ban(target.id, moderator.cookie);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(
        // The page escapes the apostrophe.
        "Nothing changed: a moderator or an admin can&#39;t be banned.",
      );
      expect(await bannedAt(target.id)).toBeNull();
      expect(await logFor(target.id)).toEqual([]);
    }
    // So the work page offers no form for their uploads.
    await seedWork(db, { ao3WorkId: W + 1, title: "mod6-by-moderator", userId: other.id });
    const page = await (await get(`/admin/works/${W + 1}`, moderator.cookie)).text();
    expect(page).not.toContain("Ban uploader");
  });

  it("An unknown account is not found", async () => {
    const res = await ban("mod6-nobody", moderator.cookie);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await logFor("mod6-nobody")).toEqual([]);
  });

  it("A reader who is not a moderator can't ban, and gets the not-found answer", async () => {
    const x = await signIn("mod6-x@example.test");
    const reader = await signIn("mod6-reader@example.test");
    for (const cookie of [reader.cookie, undefined]) {
      const res = await ban(x.id, cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await bannedAt(x.id)).toBeNull();
    expect(await logFor(x.id)).toEqual([]);
  });

  it("A cross-site ban is refused with the not-found answer", async () => {
    const x = await signIn("mod6-cross@example.test");
    const res = await fetchW(`/admin/users/${x.id}/ban`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
        cookie: moderator.cookie,
      },
      body: "",
    });
    expect(res.status).toBe(404);
    expect(await bannedAt(x.id)).toBeNull();
  });
});
