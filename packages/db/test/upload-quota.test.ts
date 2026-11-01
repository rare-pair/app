import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countUploadQuota,
  createDb,
  getUploadQuota,
  insertUpload,
  refundUploadQuota,
  rejectOverQuotaUpload,
  useUploadQuota,
} from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

// U4: the daily upload quota, counted in Postgres. The day is the UTC calendar day.
let t: TestDb;
beforeAll(async () => {
  // `db` plus the clients of "parallel confirms".
  t = await createTestDb({ maxConnections: 8 });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

// A fresh user, none of whose quota is used.
async function freshUser() {
  const w = await seedWork(t.db, {});
  return w.userId;
}

const setUsed = (userId: string, used: number, day: typeof TODAY | null) =>
  t.db
    .updateTable("user")
    .set({ upload_quota_used: used, upload_quota_day: day })
    .where("id", "=", userId)
    .execute();

const usedOf = (userId: string) =>
  t.db
    .selectFrom("user")
    .select("upload_quota_used")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

const TODAY = sql<string>`(now() at time zone 'utc')::date`;
// The database's UTC day before today, the clock the quota itself uses, not the JS clock.
const YESTERDAY = sql<string>`(now() at time zone 'utc')::date - 1`;

describe("19-surge-controls-and-quotas: the counter", () => {
  it("counts a use against today and stops at the limit", async () => {
    const userId = await freshUser();
    expect(await getUploadQuota(t.db, userId)).toEqual({ role: null, usedToday: 0 });
    const uses = [
      await useUploadQuota(t.db, userId, 2),
      await useUploadQuota(t.db, userId, 2),
      await useUploadQuota(t.db, userId, 2),
    ];
    expect(uses).toEqual([true, true, false]);
    expect((await getUploadQuota(t.db, userId))?.usedToday).toBe(2);
    expect((await usedOf(userId)).upload_quota_used).toBe(2);
  });

  it("starts the count again on a new UTC day", async () => {
    const userId = await freshUser();
    await setUsed(userId, 5, YESTERDAY);
    // Yesterday's use isn't today's.
    expect((await getUploadQuota(t.db, userId))?.usedToday).toBe(0);
    expect(await useUploadQuota(t.db, userId, 5)).toBe(true);
    expect((await usedOf(userId)).upload_quota_used).toBe(1);
  });

  it("a counter that was never dated counts from zero", async () => {
    const userId = await freshUser();
    await setUsed(userId, 9, null);
    expect(await useUploadQuota(t.db, userId, 3)).toBe(true);
    expect((await usedOf(userId)).upload_quota_used).toBe(1);
  });

  it("a limit of zero refuses, even on a new day", async () => {
    const userId = await freshUser();
    await setUsed(userId, 3, YESTERDAY);
    expect(await useUploadQuota(t.db, userId, 0)).toBe(false);
  });

  it("an unknown user has no quota to use", async () => {
    expect(await getUploadQuota(t.db, "no-such-user")).toBeNull();
    expect(await useUploadQuota(t.db, "no-such-user", 5)).toBe(false);
  });

  it("Quota is a hard limit under concurrency", async () => {
    const userId = await freshUser();
    const limit = 3;
    const clients = Array.from({ length: 6 }, () =>
      createDb({ connectionString: t.connectionString, max: 1 }),
    );
    try {
      const results = await Promise.all(clients.map((c) => useUploadQuota(c, userId, limit)));
      expect(results.filter(Boolean)).toHaveLength(limit);
      expect((await usedOf(userId)).upload_quota_used).toBe(limit);
    } finally {
      await Promise.all(clients.map((c) => c.destroy()));
    }
  });

  it("reads the role with the count", async () => {
    const userId = await freshUser();
    await t.db.updateTable("user").set({ role: "moderator" }).where("id", "=", userId).execute();
    expect((await getUploadQuota(t.db, userId))?.role).toBe("moderator");
  });
});

// A pending upload for `userId`.
const pendingFor = async (userId: string) =>
  (await insertUpload(t.db, { userId, r2Key: `uploads/${crypto.randomUUID()}`, bytes: 10 })).id;

const countedAtOf = async (uploadId: string) =>
  (
    await t.db
      .selectFrom("uploads")
      .select("quota_counted_at")
      .where("id", "=", uploadId)
      .executeTakeFirstOrThrow()
  ).quota_counted_at;

describe("19-surge-controls-and-quotas: counting an upload once", () => {
  it("counts an upload once, however often it is confirmed", async () => {
    const userId = await freshUser();
    const up = await pendingFor(userId);
    const outcomes = [
      await countUploadQuota(t.db, userId, up, 3),
      await countUploadQuota(t.db, userId, up, 3),
    ];
    expect(outcomes).toEqual(["counted", "already"]);
    expect((await usedOf(userId)).upload_quota_used).toBe(1);
    expect(await countedAtOf(up)).not.toBeNull();
  });

  it("a spent quota changes nothing, and the upload can be counted later", async () => {
    const userId = await freshUser();
    await setUsed(userId, 2, TODAY);
    const up = await pendingFor(userId);
    expect(await countUploadQuota(t.db, userId, up, 2)).toBe("spent");
    expect((await usedOf(userId)).upload_quota_used).toBe(2);
    expect(await countedAtOf(up)).toBeNull();
    expect(await countUploadQuota(t.db, userId, up, 3)).toBe("counted");
  });

  it("parallel confirms of one upload with one use left count it once and both go on", async () => {
    const userId = await freshUser();
    await setUsed(userId, 2, TODAY);
    const up = await pendingFor(userId);
    const clients = [0, 1].map(() => createDb({ connectionString: t.connectionString, max: 1 }));
    try {
      const outcomes = await Promise.all(clients.map((c) => countUploadQuota(c, userId, up, 3)));
      expect([...outcomes].sort((x, y) => x.localeCompare(y))).toEqual(["already", "counted"]);
      expect((await usedOf(userId)).upload_quota_used).toBe(3);
    } finally {
      await Promise.all(clients.map((c) => c.destroy()));
    }
  });

  it("an upload counted is not rejected over the quota", async () => {
    const userId = await freshUser();
    const up = await pendingFor(userId);
    await countUploadQuota(t.db, userId, up, 5);
    expect(await rejectOverQuotaUpload(t.db, up)).toBe(false);
  });

  it("a refund gives the use back once, and the upload can be counted again", async () => {
    const userId = await freshUser();
    const up = await pendingFor(userId);
    await countUploadQuota(t.db, userId, up, 5);
    await refundUploadQuota(t.db, userId, up);
    expect((await usedOf(userId)).upload_quota_used).toBe(0);
    expect(await countedAtOf(up)).toBeNull();
    // A second refund has nothing to give back.
    await refundUploadQuota(t.db, userId, up);
    expect((await usedOf(userId)).upload_quota_used).toBe(0);
    expect(await countUploadQuota(t.db, userId, up, 5)).toBe("counted");
  });

  it("a refund after the day has turned leaves the new day's count alone", async () => {
    const userId = await freshUser();
    const up = await pendingFor(userId);
    await countUploadQuota(t.db, userId, up, 5);
    // The use was taken yesterday; today another upload has counted.
    await t.db
      .updateTable("uploads")
      .set({ quota_counted_at: sql<Date>`now() - interval '1 day'` })
      .where("id", "=", up)
      .execute();
    await setUsed(userId, 3, TODAY);
    await refundUploadQuota(t.db, userId, up);
    expect((await usedOf(userId)).upload_quota_used).toBe(3);
  });
});

describe("19-surge-controls-and-quotas: an upload over the quota", () => {
  it("is marked over_quota only while it is pending", async () => {
    const userId = await freshUser();
    const { id } = await insertUpload(t.db, {
      userId,
      r2Key: `uploads/${crypto.randomUUID()}`,
      bytes: 10,
    });
    expect(await rejectOverQuotaUpload(t.db, id)).toBe(true);
    const row = await t.db
      .selectFrom("uploads")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("over_quota");
    expect(await rejectOverQuotaUpload(t.db, id)).toBe(false);
  });
});
