import { createDb, insertUpload } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { BASE, deliveredIngest, fetchW, postLogin, signIn as signInAs } from "./helpers";

// U2's cases: `POST /uploads/:id/complete`, which checks the object `PUT /uploads/:id` stored,
// hashes it, and either marks it a duplicate or enqueues it. The test puts the object in
// `env.BUCKET` itself, so it can also store one the route never would.
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

/** An upload row as `POST /uploads` leaves it, and the object its PUT stored. */
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

/** The upload's row and object are gone, so its slot is free. */
async function expectFreed(up: { id: string; key: string }) {
  expect(
    await db.selectFrom("uploads").select("id").where("id", "=", up.id).executeTakeFirst(),
  ).toBeUndefined();
  expect(await env.BUCKET.head(up.key)).toBeNull();
}

/** A confirm in this isolate, on these bindings, for what Miniflare can't be made to do. */
type Faulty = {
  INGEST?: { send: () => Promise<never> };
  BUCKET?: { get: () => Promise<never>; delete: (key: string) => Promise<void> };
};

async function completeWith(id: string, cookie: string, bindings: Faulty) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${BASE}/uploads/${id}/complete`, {
      method: "POST",
      headers: { cookie, origin: BASE, "sec-fetch-site": "same-origin" },
    }),
    { ...env, ...bindings },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const QUEUE_DOWN = {
  INGEST: {
    send: async () => {
      throw new TypeError("queue down");
    },
  },
};

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

  // The earlier upload has no work, as the scenarios give: it is still in the pipeline, or
  // was rejected.
  it.each([
    ["Hash match on an upload still being processed gets no shortcut", "pending"],
    ["Hash match on an upload still being processed gets no shortcut", "processing"],
    ["Hash match on a rejected upload gets no shortcut", "not_ao3"],
  ] as const)("%s: %s earlier upload", async (_title, status) => {
    const { userId, cookie } = await signIn(`u7-${status}@example.test`);
    const bytes = randomBytes(500);
    const earlier = await uploaded(userId, bytes);
    await db
      .updateTable("uploads")
      .set({ sha256: await sha256Hex(bytes), status })
      .where("id", "=", earlier.id)
      .execute();
    const up = await uploaded(userId, bytes);
    expect((await complete(up.id, { cookie })).status).toBe(200);
    expect(await ingestFor(up.id)).toEqual([{ upload_id: up.id }]);
    expect(await rowOf(up.id)).toEqual({
      status: "pending",
      work_id: null,
      sha256: await sha256Hex(bytes),
    });
  });

  it.each([
    ["larger", 2000, 1000],
    ["smaller", 1000, 2000],
    ["over 25 MiB", MAX + 1, 1],
  ])(
    "Confirm refuses a stored file of another size than declared and frees its slot: %s",
    async (word, stored, declared) => {
      const { userId, cookie } = await signIn(`uploadcap-size-${word.at(0)}@example.test`);
      const up = await uploaded(userId, new Uint8Array(stored), declared);

      const res = await complete(up.id, { cookie });

      await expectRefused(res.clone(), 400);
      // SAFETY: POST /uploads/:id/complete answers JSON.
      expect(((await res.json()) as { error: string }).error).toMatch(/size/);
      await expectFreed(up);
      // Not counted against the quota, and never queued.
      expect(await usedOf(userId)).toBe(0);
      await queueDrained(userId, cookie);
      expect(await ingestSent(up.id)).toEqual([]);
    },
  );

  it("A confirm that can't reach the queue frees the slot and gives back the use", async () => {
    const { userId, cookie } = await signIn("upslot-send-fails@example.test");
    const up = await uploaded(userId, randomBytes(1000));
    await setUsedToday(userId, 3);

    const res = await completeWith(up.id, cookie, QUEUE_DOWN);

    await expectRefused(res.clone(), 503);
    // SAFETY: POST /uploads/:id/complete answers JSON.
    expect(((await res.json()) as { error: string }).error).toMatch(/upload it again/);
    await expectFreed(up);
    expect(await usedOf(userId)).toBe(3);
  });

  it("A confirm that faults frees the slot", async () => {
    const { userId, cookie } = await signIn("upslot-confirm-fault@example.test");
    const up = await uploaded(userId, randomBytes(1000));
    const bucket = {
      get: async () => {
        throw new TypeError("R2 is down");
      },
      delete: (key: string) => env.BUCKET.delete(key),
    };

    const res = await completeWith(up.id, cookie, { BUCKET: bucket });

    await expectRefused(res, 500);
    await expectFreed(up);
    expect(await usedOf(userId)).toBe(0);
  });

  it("A confirmed upload's object is left alone by a repeat confirm of another size", async () => {
    const { userId, cookie } = await signIn("uploadcap-size-counted@example.test");
    const up = await uploaded(userId, randomBytes(1000));
    expect((await complete(up.id, { cookie })).status).toBe(200);
    await env.BUCKET.put(up.key, randomBytes(2000));

    await expectRefused(await complete(up.id, { cookie }), 409);

    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("A confirmed upload's object is left alone by a repeat confirm of an oversized file", async () => {
    const { userId, cookie } = await signIn("uploadcap-oversized-counted@example.test");
    const up = await uploaded(userId, randomBytes(1000));
    expect((await complete(up.id, { cookie })).status).toBe(200);
    await env.BUCKET.put(up.key, new Uint8Array(MAX + 1));

    await expectRefused(await complete(up.id, { cookie }), 409);

    expect(await env.BUCKET.head(up.key)).not.toBeNull();
    expect((await rowOf(up.id)).status).toBe("pending");
  });

  it("Confirming an upload the reaper has removed answers as an unknown one", async () => {
    const { userId, cookie } = await signIn("uploadcap-confirm-reaped@example.test");
    const up = await uploaded(userId, randomBytes(1000));
    await db.deleteFrom("uploads").where("id", "=", up.id).execute();

    await expectRefused(await complete(up.id, { cookie }), 404);
  });

  it("A repeat confirm that can't reach the queue leaves the upload confirmed", async () => {
    const { userId, cookie } = await signIn("uploadcap-repeat-refund@example.test");
    const up = await uploaded(userId, randomBytes(1000));
    expect((await complete(up.id, { cookie })).status).toBe(200);
    expect(await usedOf(userId)).toBe(1);

    await expectRefused(await completeWith(up.id, cookie, QUEUE_DOWN), 503);
    // Its first message is still in the queue: giving the use back would make it look unconfirmed,
    // and the reaper would take it.
    expect(await usedOf(userId)).toBe(1);
    const row = await db
      .selectFrom("uploads")
      .select("quota_counted_at")
      .where("id", "=", up.id)
      .executeTakeFirstOrThrow();
    expect(row.quota_counted_at).not.toBeNull();
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

  it("An upload whose object never arrived is refused and frees its slot", async () => {
    const { userId, cookie } = await signIn("u2-missing@example.test");
    const up = await uploaded(userId, null);
    await expectRefused(await complete(up.id, { cookie }), 400);
    await expectFreed(up);
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
// The database's UTC day, the clock the quota itself uses: never the JS clock, which can
// disagree with it for a moment around 00:00 UTC.
const today = sql<string>`(now() at time zone 'utc')::date`;

const setUsedToday = (userId: string, used: number) =>
  db
    .updateTable("user")
    .set({ upload_quota_used: used, upload_quota_day: today })
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
    // Refused before the object is read: not counted, not queued, the object is deleted and
    // the upload marked, so a spent quota can't pile up stored files.
    expect(await usedOf(userId)).toBe(NEW_LIMIT);
    expect(await env.BUCKET.head(over.key)).toBeNull();
    expect((await rowOf(over.id)).status).toBe("over_quota");
    const control = await signIn("u4-past-limit-control@example.test");
    await queueDrained(control.userId, control.cookie);
    expect(await ingestSent(over.id)).toEqual([]);
  });

  it("Confirming the same upload twice at once with one use left counts it once and queues it", async () => {
    const { userId, cookie } = await signIn("u4-same-upload@example.test");
    await setUsedToday(userId, NEW_LIMIT - 1);
    const up = await uploaded(userId, randomBytes());
    const replies = await Promise.all([complete(up.id, { cookie }), complete(up.id, { cookie })]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(await usedOf(userId)).toBe(NEW_LIMIT);
    // Neither request rejected the other's upload or deleted its object.
    expect((await rowOf(up.id)).status).toBe("pending");
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
    expect(await ingestFor(up.id)).not.toEqual([]);
  });

  it("Quota is a hard limit under concurrency", async () => {
    const { userId, cookie } = await signIn("u4-concurrent@example.test");
    await setUsedToday(userId, NEW_LIMIT - 1);
    const a = await uploaded(userId, randomBytes());
    const b = await uploaded(userId, randomBytes());
    const [ra, rb] = await Promise.all([complete(a.id, { cookie }), complete(b.id, { cookie })]);
    expect([ra.status, rb.status].sort((x, y) => x - y)).toEqual([200, 429]);
    expect(await usedOf(userId)).toBe(NEW_LIMIT);
    // Only the winner is queued. The loser is refused at the early check or at the count,
    // and either way is marked over quota and not queued.
    const [winner, loser] = ra.status === 200 ? [a, b] : [b, a];
    expect(await ingestFor(winner.id)).toEqual([{ upload_id: winner.id }]);
    expect(await ingestSent(loser.id)).toEqual([]);
    expect((await rowOf(loser.id)).status).toBe("over_quota");
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
