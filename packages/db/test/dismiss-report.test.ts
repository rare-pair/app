import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dismissReport, hideWork, restoreWork } from "../src/index";
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
  const id = `dismiss-user-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

const addReport = async (workId: string, reporter: string, kind = "other") => {
  const row = await t.db
    .insertInto("reports")
    .values({ work_id: workId, reporter_id: reporter, kind })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
};

const reportStatus = async (id: string) =>
  (await t.db.selectFrom("reports").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const workState = (workId: string) =>
  t.db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("id", "=", workId)
    .executeTakeFirstOrThrow();

const logFor = (targetId: string) =>
  t.db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id", "note", "created_at"])
    .where("target_id", "=", targetId)
    .execute();

describe("18-moderation", () => {
  it("A moderator dismisses a report", async () => {
    const { workId } = await seedWork(t.db);
    const moderator = await addUser();
    const id = await addReport(workId, await addUser());

    expect(await dismissReport(t.db, id, { actor: moderator })).toBe("dismissed");

    expect(await reportStatus(id)).toBe("closed");
    const [row, ...rest] = await logFor(id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      moderator_id: moderator,
      action: "dismiss",
      target_kind: "report",
      target_id: id,
      note: null,
    });
    expect(row?.created_at).toBeInstanceOf(Date);
    expect(await workState(workId)).toEqual({ status: "live", hidden_cause: null });
    expect(await logFor(workId)).toEqual([]);
  });

  it("Dismissing a report leaves a hidden work hidden", async () => {
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    const id = await addReport(workId, await addUser());
    expect(await dismissReport(t.db, id, { actor: await addUser() })).toBe("dismissed");
    expect(await workState(workId)).toEqual({ status: "hidden", hidden_cause: "reports" });
  });

  it("A report on a removed work can be dismissed", async () => {
    // The Reports queue lists it, and nothing else would take it off.
    const { workId } = await seedWork(t.db, { status: "removed" });
    const id = await addReport(workId, await addUser());
    expect(await dismissReport(t.db, id, { actor: await addUser() })).toBe("dismissed");
    expect(await reportStatus(id)).toBe("closed");
    expect((await workState(workId)).status).toBe("removed");
  });

  it("Dismissing a closed report changes nothing", async () => {
    const { workId } = await seedWork(t.db);
    const moderator = await addUser();
    const id = await addReport(workId, await addUser());
    const dismissals = [
      await dismissReport(t.db, id, { actor: moderator }),
      await dismissReport(t.db, id, { actor: moderator }),
    ];
    expect(dismissals).toEqual(["dismissed", "closed"]);
    expect(await logFor(id)).toHaveLength(1);
  });

  it("A wrong-version report can't be dismissed", async () => {
    const { workId } = await seedWork(t.db);
    const moderator = await addUser();
    const wrong = await addReport(workId, await addUser(), "wrong_version");
    expect(await dismissReport(t.db, wrong, { actor: moderator })).toBe("missing");
    expect(await reportStatus(wrong)).toBe("open");
    expect(await logFor(wrong)).toEqual([]);
    expect(await dismissReport(t.db, "dismiss-no-such-report", { actor: moderator })).toBe(
      "missing",
    );
  });

  it("A dismissed report stops counting toward the automatic hide", async () => {
    const { workId } = await seedWork(t.db);
    const [u, u2, u3, u4] = [await addUser(), await addUser(), await addUser(), await addUser()];
    await addReport(workId, u);
    await addReport(workId, u2);
    const dismissed = await addReport(workId, u3);
    await dismissReport(t.db, dismissed, { actor: await addUser() });

    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(false);
    expect((await workState(workId)).status).toBe("live");

    await addReport(workId, u4);
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(true);
  });

  it("An account with another open report on the work still counts", async () => {
    const { workId } = await seedWork(t.db);
    const [u, u2, u3] = [await addUser(), await addUser(), await addUser()];
    await addReport(workId, u);
    await addReport(workId, u2);
    const dismissed = await addReport(workId, u3);
    await addReport(workId, u3);
    await dismissReport(t.db, dismissed, { actor: await addUser() });
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(true);
  });

  it("A dismissal rolls back with the caller's transaction, log row and all", async () => {
    const { workId } = await seedWork(t.db);
    const id = await addReport(workId, await addUser());
    const moderator = await addUser();
    await expect(
      t.db.transaction().execute(async (trx) => {
        await dismissReport(trx, id, { actor: moderator });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await reportStatus(id)).toBe("open");
    expect(await logFor(id)).toEqual([]);
  });

  it("A log row that cannot be written leaves the report open", async () => {
    const { workId } = await seedWork(t.db);
    const id = await addReport(workId, await addUser());
    const moderator = await addUser();
    // The log has no foreign key to fail on, so make every insert fail with a trigger.
    await sql`
      create function dismiss_refuse() returns trigger language plpgsql as
      $ begin raise exception 'log refused'; end $`.execute(t.db);
    await sql`
      create trigger dismiss_refuse before insert on moderation_actions
      for each row execute function dismiss_refuse()`.execute(t.db);
    try {
      await expect(dismissReport(t.db, id, { actor: moderator })).rejects.toThrow("log refused");
      expect(await reportStatus(id)).toBe("open");
    } finally {
      await sql`drop trigger dismiss_refuse on moderation_actions`.execute(t.db);
      await sql`drop function dismiss_refuse()`.execute(t.db);
    }
  });

  it("restoreWork with keepReportsOpen leaves the work's reports open", async () => {
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "removal_request" });
    const id = await addReport(workId, await addUser());
    const wrong = await addReport(workId, await addUser(), "wrong_version");
    expect(await restoreWork(t.db, workId, { keepReportsOpen: true })).toBe(true);
    expect((await workState(workId)).status).toBe("live");
    expect(await reportStatus(id)).toBe("open");
    expect(await reportStatus(wrong)).toBe("open");
  });
});
