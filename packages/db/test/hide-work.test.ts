import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hideWork } from "../src/index";
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

let users = 0;
async function addUser() {
  const id = `hide-user-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

async function report(workId: string, reporter_id: string, kind = "other") {
  await t.db.insertInto("reports").values({ work_id: workId, reporter_id, kind }).execute();
}

const state = (workId: string) =>
  t.db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("id", "=", workId)
    .executeTakeFirstOrThrow();

describe("hideWork", () => {
  it("Hides a live work with its cause", async () => {
    const { workId } = await seedWork(t.db);
    expect(await hideWork(t.db, workId, "moderator")).toBe(true);
    expect(await state(workId)).toEqual({ status: "hidden", hidden_cause: "moderator" });
  });

  it("Leaves a hidden or removed work as it is", async () => {
    const hidden = await seedWork(t.db, { status: "hidden", hiddenCause: "removal_request" });
    const removed = await seedWork(t.db, { status: "removed" });
    expect(await hideWork(t.db, hidden.workId, "reports")).toBe(false);
    expect(await hideWork(t.db, removed.workId, "reports")).toBe(false);
    expect(await state(hidden.workId)).toEqual({
      status: "hidden",
      hidden_cause: "removal_request",
    });
    expect((await state(removed.workId)).status).toBe("removed");
  });

  it("Hides only at the reporter count, counting each account once", async () => {
    const { workId } = await seedWork(t.db);
    const [u, u2, u3] = [await addUser(), await addUser(), await addUser()];
    await report(workId, u);
    await report(workId, u2);
    await report(workId, u);
    await report(workId, u2);
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(false);
    expect((await state(workId)).status).toBe("live");
    await report(workId, u3);
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(true);
    expect(await state(workId)).toEqual({ status: "hidden", hidden_cause: "reports" });
  });

  it("Never counts wrong_version reports or reports that are not open", async () => {
    const { workId } = await seedWork(t.db);
    const [u, u2, u3, u4] = [await addUser(), await addUser(), await addUser(), await addUser()];
    await report(workId, u);
    await report(workId, u2);
    await report(workId, u3, "wrong_version");
    await report(workId, u4);
    await t.db
      .updateTable("reports")
      .set({ status: "closed" })
      .where("reporter_id", "=", u4)
      .execute();
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(false);
    expect((await state(workId)).status).toBe("live");
  });
});

describe("hideWork by a moderator", () => {
  it("Switches the cause of a hidden work to moderator", async () => {
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    expect(await hideWork(t.db, workId, "moderator")).toBe(true);
    expect(await state(workId)).toEqual({ status: "hidden", hidden_cause: "moderator" });
  });

  it("Leaves a removed work removed", async () => {
    const { workId } = await seedWork(t.db, { status: "removed" });
    expect(await hideWork(t.db, workId, "moderator")).toBe(false);
    expect((await state(workId)).status).toBe("removed");
  });
});
