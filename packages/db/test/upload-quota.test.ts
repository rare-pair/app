import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

const setUsed = (userId: string, used: number, day: string | null) =>
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

const YESTERDAY = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);

describe("19-surge-controls-and-quotas: the counter", () => {
  it("counts a use against today and stops at the limit", async () => {
    const userId = await freshUser();
    expect(await getUploadQuota(t.db, userId)).toEqual({ role: null, usedToday: 0 });
    expect(await useUploadQuota(t.db, userId, 2)).toBe(true);
    expect(await useUploadQuota(t.db, userId, 2)).toBe(true);
    expect(await useUploadQuota(t.db, userId, 2)).toBe(false);
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

  it("a refund gives one use back, and not below zero or across days", async () => {
    const userId = await freshUser();
    await useUploadQuota(t.db, userId, 2);
    await refundUploadQuota(t.db, userId);
    expect((await usedOf(userId)).upload_quota_used).toBe(0);
    await refundUploadQuota(t.db, userId);
    expect((await usedOf(userId)).upload_quota_used).toBe(0);
    await setUsed(userId, 4, YESTERDAY);
    await refundUploadQuota(t.db, userId);
    expect((await usedOf(userId)).upload_quota_used).toBe(4);
  });

  it("reads the role with the count", async () => {
    const userId = await freshUser();
    await t.db.updateTable("user").set({ role: "moderator" }).where("id", "=", userId).execute();
    expect((await getUploadQuota(t.db, userId))?.role).toBe("moderator");
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
