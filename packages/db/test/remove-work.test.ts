import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeWork } from "../src/index";
import { seedVersion, seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

let users = 0;
async function addUser() {
  const id = `remove-user-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

const state = (workId: string) =>
  t.db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("id", "=", workId)
    .executeTakeFirstOrThrow();

const rowsFor = (targetId: string) =>
  t.db.selectFrom("moderation_actions").selectAll().where("target_id", "=", targetId).execute();

describe("removeWork", () => {
  it("Removes a live work and logs it with the moderator", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db);
    const result = await removeWork(t.db, workId, moderator);
    expect(result?.outcome).toBe("removed");
    expect(await state(workId)).toEqual({ status: "removed", hidden_cause: null });
    const rows = await rowsFor(workId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      moderator_id: moderator,
      action: "remove",
      target_kind: "work",
      target_id: workId,
    });
  });

  it("Removes a hidden work and clears its cause", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    expect((await removeWork(t.db, workId, moderator))?.outcome).toBe("removed");
    expect(await state(workId)).toEqual({ status: "removed", hidden_cause: null });
  });

  it("A repeat remove changes nothing and writes no second row", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db);
    await removeWork(t.db, workId, moderator);
    const again = await removeWork(t.db, workId, moderator);
    expect(again?.outcome).toBe("already_removed");
    expect(await rowsFor(workId)).toHaveLength(1);
  });

  it("Leaves a processing work as it is and writes no row", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db);
    await t.db.updateTable("works").set({ status: "processing" }).where("id", "=", workId).execute();
    expect((await removeWork(t.db, workId, moderator))?.outcome).toBe("processing");
    expect((await state(workId)).status).toBe("processing");
    expect(await rowsFor(workId)).toHaveLength(0);
  });

  it("Returns every upload of the work, versions and held ones alike", async () => {
    const moderator = await addUser();
    const seeded = await seedWork(t.db);
    const held = await seedVersion(t.db, seeded, { current: false });
    const other = await seedWork(t.db);
    const result = await removeWork(t.db, seeded.workId, moderator);
    expect(result?.uploads.map((u) => u.id).sort()).toEqual(
      [seeded.uploadId, held.uploadId].sort(),
    );
    expect(result?.uploads.map((u) => u.r2_key)).not.toContain(`uploads/${other.uploadId}.epub`);
    expect(result?.uploads.find((u) => u.id === held.uploadId)?.r2_key).toBe(
      `uploads/${held.uploadId}.epub`,
    );
  });

  it("Is null for no such work", async () => {
    expect(await removeWork(t.db, crypto.randomUUID(), await addUser())).toBeNull();
  });
});
