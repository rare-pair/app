import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

const addRequest = (workId: string) =>
  t.db
    .insertInto("requests")
    .values({
      kind: "remove_work",
      work_id: workId,
      contact_email: "request-works@example.test",
      statement: "",
      ip_hash: "0".repeat(64),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

describe("request_works", () => {
  it("Links a request to the work it hid, once", async () => {
    const { workId } = await seedWork(t.db);
    const { id } = await addRequest(workId);
    await t.db.insertInto("request_works").values({ request_id: id, work_id: workId }).execute();
    const rows = await t.db
      .selectFrom("request_works")
      .selectAll()
      .where("request_id", "=", id)
      .execute();
    expect(rows).toEqual([{ request_id: id, work_id: workId }]);
    await expect(
      t.db.insertInto("request_works").values({ request_id: id, work_id: workId }).execute(),
    ).rejects.toThrow();
  });

  it("Refuses a work or a request that doesn't exist", async () => {
    const { workId } = await seedWork(t.db);
    const { id } = await addRequest(workId);
    await expect(
      t.db
        .insertInto("request_works")
        .values({ request_id: id, work_id: "no-such-work" })
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .insertInto("request_works")
        .values({ request_id: "no-such-request", work_id: workId })
        .execute(),
    ).rejects.toThrow();
  });
});
