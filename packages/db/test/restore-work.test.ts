import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hideWork, restoreWork } from "../src/index";
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
  const id = `restore-user-${++users}`;
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

describe("restoreWork", () => {
  it("Makes a hidden work live and clears its cause", async () => {
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "removal_request" });
    expect(await restoreWork(t.db, workId)).toBe(true);
    expect(await state(workId)).toEqual({ status: "live", hidden_cause: null });
  });

  it("With a cause, restores only a work hidden for that cause", async () => {
    const other = await seedWork(t.db, { status: "hidden", hiddenCause: "moderator" });
    const same = await seedWork(t.db, { status: "hidden", hiddenCause: "removal_request" });
    expect(await restoreWork(t.db, other.workId, { cause: "removal_request" })).toBe(false);
    expect(await state(other.workId)).toEqual({ status: "hidden", hidden_cause: "moderator" });
    expect(await restoreWork(t.db, same.workId, { cause: "removal_request" })).toBe(true);
    expect(await state(same.workId)).toEqual({ status: "live", hidden_cause: null });
  });

  it("With noPendingRequests, stays hidden while a request for it is pending", async () => {
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "removal_request" });
    await t.db
      .insertInto("requests")
      .values({
        kind: "remove_work",
        work_id: workId,
        contact_email: "restore-pending@example.test",
        statement: "restore-pending",
        ip_hash: "restore-ip-hash",
      })
      .execute();
    expect(await restoreWork(t.db, workId, { noPendingRequests: true })).toBe(false);
    await t.db
      .updateTable("requests")
      .set({ status: "rejected" })
      .where("work_id", "=", workId)
      .execute();
    expect(await restoreWork(t.db, workId, { noPendingRequests: true })).toBe(true);
  });

  it("Leaves a live or removed work as it is", async () => {
    const live = await seedWork(t.db);
    const removed = await seedWork(t.db, { status: "removed" });
    expect(await restoreWork(t.db, live.workId)).toBe(false);
    expect(await restoreWork(t.db, removed.workId)).toBe(false);
    expect(await state(live.workId)).toEqual({ status: "live", hidden_cause: null });
    expect((await state(removed.workId)).status).toBe("removed");
  });

  it("Closes the work's open reports, and no one else's", async () => {
    const mine = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    const other = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    const u = await addUser();
    await t.db
      .insertInto("reports")
      .values([
        { work_id: mine.workId, reporter_id: u, kind: "other" },
        { work_id: other.workId, reporter_id: u, kind: "other" },
      ])
      .execute();
    expect(await restoreWork(t.db, mine.workId)).toBe(true);
    const rows = await t.db
      .selectFrom("reports")
      .select(["work_id", "status"])
      .where("work_id", "in", [mine.workId, other.workId])
      .execute();
    expect(rows.find((r) => r.work_id === mine.workId)?.status).toBe("closed");
    expect(rows.find((r) => r.work_id === other.workId)?.status).toBe("open");
  });

  it("Does not count the closed reports toward hiding again", async () => {
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    const reporters = [await addUser(), await addUser(), await addUser()];
    await t.db
      .insertInto("reports")
      .values(reporters.map((reporter_id) => ({ work_id: workId, reporter_id, kind: "other" })))
      .execute();
    await restoreWork(t.db, workId);
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(false);
  });
});
