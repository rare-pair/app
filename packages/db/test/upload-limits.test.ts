import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, insertUploadsWithinCap } from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  // `db` plus the clients of "parallel asks".
  t = await createTestDb({ maxConnections: 8 });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

const freshUser = async () => (await seedWork(t.db, {})).userId;

const files = (n: number) =>
  Array.from({ length: n }, () => {
    const id = crypto.randomUUID();
    return { id, r2Key: `uploads/${id}`, bytes: 10 };
  });

const openOf = async (userId: string) =>
  (
    await t.db
      .selectFrom("uploads")
      .select("id")
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .where("quota_counted_at", "is", null)
      .execute()
  ).length;

describe("02-upload-handshake: the cap on open uploads", () => {
  it("inserts the files that fit, and none of a batch that doesn't", async () => {
    const userId = await freshUser();
    const ask = (n: number) => insertUploadsWithinCap(t.db, userId, files(n), 3);
    const first = await ask(2);
    const tooMany = await ask(2);
    expect(await openOf(userId)).toBe(2);
    const last = await ask(1);
    const full = await ask(1);
    expect([first, tooMany, last, full]).toEqual([
      { inserted: true },
      { inserted: false, left: 1 },
      { inserted: true },
      { inserted: false, left: 0 },
    ]);
  });

  it("parallel asks can't pass the cap together", async () => {
    const userId = await freshUser();
    const clients = [0, 1, 2, 3].map(() =>
      createDb({ connectionString: t.connectionString, max: 1 }),
    );
    try {
      const outcomes = await Promise.all(
        clients.map((c) => insertUploadsWithinCap(c, userId, files(1), 2)),
      );
      expect(outcomes.filter((o) => o.inserted)).toHaveLength(2);
      expect(await openOf(userId)).toBe(2);
    } finally {
      await Promise.all(clients.map((c) => c.destroy()));
    }
  });
});
