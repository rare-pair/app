import { createDb, insertUpload } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { deliveredIngest, fetchW, postLogin, signIn as signInAs } from "./helpers";

// U2's cases: `POST /uploads/:id/complete`, which checks the object a presigned PUT stored,
// hashes it, and either marks it a duplicate or enqueues it. The test puts the object in
// `env.BUCKET` itself, as the browser's PUT would have: Miniflare's R2 has no S3 endpoint.
// The `ingest` queue's consumer is vitest.config.ts's ingest-sink.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const MAX = 25 * 1024 * 1024;

async function signIn(email: string): Promise<{ userId: string; cookie: string }> {
  const cookie = await signInAs(email, { next: "/upload", acceptTerms: true });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { userId: user.id, cookie };
}

/** An upload row as `POST /uploads` leaves it, and the object the browser's PUT stored. */
async function uploaded(
  userId: string,
  bytes: Uint8Array | null,
  declared = bytes?.byteLength ?? 1,
) {
  const id = crypto.randomUUID();
  const key = `uploads/${id}`;
  await insertUpload(db, { id, userId, r2Key: key, bytes: declared });
  if (bytes !== null) await env.BUCKET.put(key, bytes);
  return { id, key };
}

/** The upload page's script confirming an upload, as a browser on rarepair.fans sends it. */
const complete = (id: string, headers: Record<string, string> = {}) =>
  postLogin({}, { url: `/uploads/${id}/complete`, headers });

const rowOf = (id: string) =>
  db
    .selectFrom("uploads")
    .select(["status", "sha256", "work_id"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

/** Bytes that are no real epub and no fic: random, so no two tests share a hash. */
const randomBytes = (n = 64) => crypto.getRandomValues(new Uint8Array(n));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The messages the queue has delivered so far for `uploadId`. */
async function ingestSent(uploadId: string): Promise<unknown[]> {
  // SAFETY: the sink delivers the bodies the Worker sent, each an object with `upload_id`.
  return (await deliveredIngest()).filter(
    (m) => (m as { upload_id?: string }).upload_id === uploadId,
  );
}

/** Waits for the queue to deliver a message for `uploadId`, and returns every one for it. */
async function ingestFor(uploadId: string): Promise<unknown[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const mine = await ingestSent(uploadId);
    if (mine.length > 0 || Date.now() > deadline) return mine;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Confirms a fresh control upload and waits for its message. The queue delivers in order,
 * so once it has come, anything sent earlier would have too.
 */
async function queueDrained(userId: string, cookie: string) {
  const control = await uploaded(userId, randomBytes());
  expect((await complete(control.id, { cookie })).status).toBe(200);
  expect(await ingestFor(control.id)).toEqual([{ upload_id: control.id }]);
}

async function expectRefused(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // SAFETY: POST /uploads/:id/complete answers JSON.
  const body = (await res.json()) as { error?: string };
  expect(body.error).toEqual(expect.any(String));
}

describe("02-upload-handshake", () => {
  it("Confirm enqueues the upload", async () => {
    const { userId, cookie } = await signIn("u2-enqueue@example.test");
    const bytes = randomBytes(1000);
    const up = await uploaded(userId, bytes);

    const res = await complete(up.id, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(await ingestFor(up.id)).toEqual([{ upload_id: up.id }]);
    // Lowercase hex; the expected value is the platform's digest of the bytes PUT.
    expect(await rowOf(up.id)).toEqual({
      status: "pending",
      sha256: await sha256Hex(bytes),
      work_id: null,
    });
    // The object stays for ingest to read.
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("Confirm marks a byte-identical re-upload as duplicate", async () => {
    const { userId, cookie } = await signIn("u2-duplicate@example.test");
    const bytes = randomBytes(2000);
    const w = await seedWork(db, {});
    await db
      .updateTable("uploads")
      .set({ sha256: await sha256Hex(bytes) })
      .where("id", "=", w.uploadId)
      .execute();
    const up = await uploaded(userId, bytes);

    const res = await complete(up.id, { cookie });
    expect(res.status).toBe(200);
    // The work's internal id isn't told: GET /uploads/:id links it, only while it is live.
    expect(await res.json()).toEqual({ status: "duplicate" });

    expect(await rowOf(up.id)).toEqual({
      status: "duplicate",
      sha256: await sha256Hex(bytes),
      work_id: w.workId,
    });
    // No second copy is kept: not in originals/, and the uploads/ object is gone.
    expect(await env.BUCKET.head(up.key)).toBeNull();
    // Other test files write to the shared bucket, so only keys naming this upload count.
    const originals = (await env.BUCKET.list({ prefix: "originals/" })).objects;
    expect(originals.filter((o) => o.key.includes(up.id))).toEqual([]);
    // The uploader's poll shows "Already in the archive" with a link to the work.
    const poll = await fetchW(`/uploads/${up.id}`, { headers: { cookie } });
    expect(await poll.json()).toEqual({
      id: up.id,
      status: "duplicate",
      work: { id: w.ao3WorkId, url: `/works/${w.ao3WorkId}` },
    });
    // And the work still points at its own version.
    const work = await db
      .selectFrom("works")
      .select("current_version_id")
      .where("id", "=", w.workId)
      .executeTakeFirstOrThrow();
    expect(work.current_version_id).toBe(w.versionId);
    await queueDrained(userId, cookie);
    expect(await ingestSent(up.id)).toEqual([]);
  });

  it("Byte-identical re-upload is marked duplicate at confirm", async () => {
    const { userId, cookie } = await signIn("u2-dedupe-v1@example.test");
    const w = await seedWork(db, {});
    const bytes = randomBytes(3000);
    // v1's file: the version's upload carries its hash.
    await db
      .updateTable("uploads")
      .set({ sha256: await sha256Hex(bytes) })
      .where("id", "=", w.uploadId)
      .execute();
    const up = await uploaded(userId, bytes);
    expect((await complete(up.id, { cookie })).status).toBe(200);
    const row = await rowOf(up.id);
    expect(row.status).toBe("duplicate");
    expect(row.work_id).toBe(w.workId);
    const work = await db
      .selectFrom("works")
      .select("current_version_id")
      .where("id", "=", w.workId)
      .executeTakeFirstOrThrow();
    expect(work.current_version_id).toBe(w.versionId);
  });

  it("A hash match on a removed work is enqueued, not marked duplicate", async () => {
    const { userId, cookie } = await signIn("u2-removed@example.test");
    const bytes = randomBytes(500);
    const w = await seedWork(db, { status: "removed" });
    await db
      .updateTable("uploads")
      .set({ sha256: await sha256Hex(bytes) })
      .where("id", "=", w.uploadId)
      .execute();
    const up = await uploaded(userId, bytes);
    expect((await complete(up.id, { cookie })).status).toBe(200);
    expect(await ingestFor(up.id)).toEqual([{ upload_id: up.id }]);
    expect((await rowOf(up.id)).status).toBe("pending");
  });

  // Two scenario cases, 02's and 19's, with the same steps.
  describe.each([
    ["Confirm deletes an oversized object", 0],
    ["Oversized objects are cleaned up at confirm", 1],
  ])("%s", (title, n) => {
    it(title, async () => {
      const { userId, cookie } = await signIn(`u2-oversized-${n}@example.test`);
      // The declared size was small; the PUT stored 25 MiB and a byte.
      const up = await uploaded(userId, new Uint8Array(MAX + 1), 1);
      const res = await complete(up.id, { cookie });
      await expectRefused(res, 413);
      expect(await env.BUCKET.head(up.key)).toBeNull();
      expect(await rowOf(up.id)).toEqual({ status: "too_large", sha256: null, work_id: null });
      await queueDrained(userId, cookie);
      expect(await ingestSent(up.id)).toEqual([]);
    });
  });

  it("An object of exactly 25 MiB is accepted", async () => {
    const { userId, cookie } = await signIn("u2-exact@example.test");
    const bytes = new Uint8Array(MAX);
    const up = await uploaded(userId, bytes);
    expect((await complete(up.id, { cookie })).status).toBe(200);
    expect(await ingestFor(up.id)).toEqual([{ upload_id: up.id }]);
    expect((await rowOf(up.id)).sha256).toBe(await sha256Hex(bytes));
  });
});

describe("02-upload-confirm refusals", () => {
  it("An id no upload can have is an unknown upload, not a fault", async () => {
    const { cookie } = await signIn("u2-badid@example.test");
    // A NUL, which Postgres refuses, and an id over 64 characters.
    await expectRefused(await complete("%00", { cookie }), 404);
    await expectRefused(await complete("x".repeat(65), { cookie }), 404);
  });

  it("An oversized object of an upload that is no longer pending is left alone", async () => {
    const { userId, cookie } = await signIn("u2-oversized-race@example.test");
    const up = await uploaded(userId, new Uint8Array(MAX + 1), 1);
    // Another confirm has already taken the row.
    await db.updateTable("uploads").set({ status: "processing" }).where("id", "=", up.id).execute();
    await expectRefused(await complete(up.id, { cookie }), 409);
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("Confirming needs an account", async () => {
    const res = await complete(crypto.randomUUID());
    await expectRefused(res, 401);
  });

  it("Confirming from another site is refused", async () => {
    const res = await postLogin(
      {},
      {
        url: `/uploads/${crypto.randomUUID()}/complete`,
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      },
    );
    await expectRefused(res, 403);
  });

  it("Another user's upload and an unknown one are refused alike", async () => {
    const owner = await signIn("u2-owner@example.test");
    const other = await signIn("u2-other@example.test");
    const up = await uploaded(owner.userId, randomBytes());
    const theirs = await complete(up.id, { cookie: other.cookie });
    const unknown = await complete(crypto.randomUUID(), { cookie: other.cookie });
    await expectRefused(theirs.clone(), 404);
    await expectRefused(unknown.clone(), 404);
    expect(await theirs.json()).toEqual(await unknown.json());
    expect((await rowOf(up.id)).sha256).toBeNull();
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("An upload whose object never arrived is refused and stays pending", async () => {
    const { userId, cookie } = await signIn("u2-missing@example.test");
    const up = await uploaded(userId, null);
    await expectRefused(await complete(up.id, { cookie }), 400);
    expect((await rowOf(up.id)).status).toBe("pending");
  });

  it("A confirm after ingest has taken the upload is refused and sends nothing", async () => {
    const { userId, cookie } = await signIn("u2-twice@example.test");
    const up = await uploaded(userId, randomBytes());
    expect((await complete(up.id, { cookie })).status).toBe(200);
    expect(await ingestFor(up.id)).toHaveLength(1);
    // The row is `pending` until ingest leases it, so a repeat is let through: ingest's lease
    // makes a second job a no-op. Once the row has moved on, the repeat is refused.
    await db.updateTable("uploads").set({ status: "processing" }).where("id", "=", up.id).execute();
    await expectRefused(await complete(up.id, { cookie }), 409);
    await queueDrained(userId, cookie);
    expect(await ingestFor(up.id)).toHaveLength(1);
  });
});

// U4: the daily quota counts the uploads that reach confirm, and the hard cap is enforced here.
// The tiers' numbers are wrangler.jsonc's vars, so the tests follow them.
const NEW_LIMIT = Number(env.UPLOAD_QUOTA_NEW);
const TRUSTED_LIMIT = Number(env.UPLOAD_QUOTA_TRUSTED);
const today = () => new Date().toISOString().slice(0, 10);

const setUsedToday = (userId: string, used: number) =>
  db
    .updateTable("user")
    .set({ upload_quota_used: used, upload_quota_day: today() })
    .where("id", "=", userId)
    .execute();

const usedOf = async (userId: string) =>
  (
    await db
      .selectFrom("user")
      .select("upload_quota_used")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow()
  ).upload_quota_used;

/** A 429 that says when to come back: the header and the JSON agree, and it is under a day. */
async function expectSpent(res: Response) {
  await expectRefused(res.clone(), 429);
  const seconds = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(seconds)).toBe(true);
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(seconds).toBeLessThanOrEqual(86400);
  // SAFETY: the 429 answers JSON.
  const body = (await res.json()) as { error?: string; retryAfter?: number };
  expect(body.retryAfter).toBe(seconds);
  expect(body.error).toMatch(/midnight UTC/);
}

describe("19-surge-controls-and-quotas", () => {
  it("Daily quota allows uploads up to the limit", async () => {
    const { userId, cookie } = await signIn("u4-up-to-limit@example.test");
    await setUsedToday(userId, NEW_LIMIT - 1);
    const last = await uploaded(userId, randomBytes());
    expect((await complete(last.id, { cookie })).status).toBe(200);
    expect(await ingestFor(last.id)).toEqual([{ upload_id: last.id }]);
    expect(await usedOf(userId)).toBe(NEW_LIMIT);
  });

  it("Daily quota refuses uploads past the limit", async () => {
    const { userId, cookie } = await signIn("u4-past-limit@example.test");
    await setUsedToday(userId, NEW_LIMIT);
    const over = await uploaded(userId, randomBytes());
    await expectSpent(await complete(over.id, { cookie }));
    // Refused, so not counted, not queued, and the object is gone.
    expect(await usedOf(userId)).toBe(NEW_LIMIT);
    expect(await env.BUCKET.head(over.key)).toBeNull();
    expect((await rowOf(over.id)).status).toBe("over_quota");
    const control = await signIn("u4-past-limit-control@example.test");
    await queueDrained(control.userId, control.cookie);
    expect(await ingestSent(over.id)).toEqual([]);
  });

  it("Quota is a hard limit under concurrency", async () => {
    const { userId, cookie } = await signIn("u4-concurrent@example.test");
    await setUsedToday(userId, NEW_LIMIT - 1);
    const a = await uploaded(userId, randomBytes());
    const b = await uploaded(userId, randomBytes());
    const [ra, rb] = await Promise.all([complete(a.id, { cookie }), complete(b.id, { cookie })]);
    expect([ra.status, rb.status].sort((x, y) => x - y)).toEqual([200, 429]);
    expect(await usedOf(userId)).toBe(NEW_LIMIT);
    const rows = await Promise.all([rowOf(a.id), rowOf(b.id)]);
    expect(rows.map((r) => r.status).sort()).toEqual(["over_quota", "pending"]);
  });

  it("Brand-new accounts get the lower quota", async () => {
    const { userId, cookie } = await signIn("u4-new-tier@example.test");
    // A brand-new account has used nothing, and is stopped at the new-account limit.
    expect(await usedOf(userId)).toBe(0);
    await setUsedToday(userId, NEW_LIMIT);
    await expectSpent(await complete((await uploaded(userId, randomBytes())).id, { cookie }));
  });

  it("Trusted users get the higher quota", async () => {
    const { userId, cookie } = await signIn("u4-trusted-tier@example.test");
    await db.updateTable("user").set({ role: "moderator" }).where("id", "=", userId).execute();
    expect(TRUSTED_LIMIT).toBeGreaterThan(NEW_LIMIT);
    // Past the new-account limit, within the trusted one.
    await setUsedToday(userId, NEW_LIMIT);
    const up = await uploaded(userId, randomBytes());
    expect((await complete(up.id, { cookie })).status).toBe(200);
    await setUsedToday(userId, TRUSTED_LIMIT);
    await expectSpent(await complete((await uploaded(userId, randomBytes())).id, { cookie }));
  });

  it("A new UTC day starts the count again", async () => {
    const { userId, cookie } = await signIn("u4-new-day@example.test");
    await db
      .updateTable("user")
      .set({ upload_quota_used: NEW_LIMIT, upload_quota_day: "2000-01-01" })
      .where("id", "=", userId)
      .execute();
    expect((await complete((await uploaded(userId, randomBytes())).id, { cookie })).status).toBe(
      200,
    );
    expect(await usedOf(userId)).toBe(1);
  });

  it("A duplicate is not counted: it costs no ingest", async () => {
    const { userId, cookie } = await signIn("u4-duplicate@example.test");
    const bytes = randomBytes(3000);
    const w = await seedWork(db, {});
    await db
      .updateTable("uploads")
      .set({ sha256: await sha256Hex(bytes) })
      .where("id", "=", w.uploadId)
      .execute();
    const up = await uploaded(userId, bytes);
    expect(await (await complete(up.id, { cookie })).json()).toEqual({ status: "duplicate" });
    expect(await usedOf(userId)).toBe(0);
  });
});
