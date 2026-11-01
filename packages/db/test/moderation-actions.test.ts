import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hideWork, logModerationAction, restoreWork } from "../src/index";
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
  const id = `modlog-user-${++users}`;
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

describe("moderation action log", () => {
  it("A moderator's hide writes one row with the moderator", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db);
    expect(await hideWork(t.db, workId, "moderator", { actor: moderator })).toBe(true);
    const rows = await rowsFor(workId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      moderator_id: moderator,
      action: "hide",
      target_kind: "work",
      target_id: workId,
      note: null,
    });
    expect(rows[0]!.created_at).toBeInstanceOf(Date);
  });

  it("A moderator's restore writes one row with the moderator", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "moderator" });
    expect(await restoreWork(t.db, workId, { actor: moderator })).toBe(true);
    const rows = await rowsFor(workId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      moderator_id: moderator,
      action: "restore",
      target_kind: "work",
    });
  });

  it("An action that changes nothing writes no row", async () => {
    const moderator = await addUser();
    const removed = await seedWork(t.db, { status: "removed" });
    expect(await hideWork(t.db, removed.workId, "moderator", { actor: moderator })).toBe(false);
    const live = await seedWork(t.db);
    expect(await restoreWork(t.db, live.workId, { actor: moderator })).toBe(false);
    expect(await rowsFor(removed.workId)).toEqual([]);
    expect(await rowsFor(live.workId)).toEqual([]);
  });

  it("Hiding a work a moderator already hid writes no second row", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db);
    const first = await hideWork(t.db, workId, "moderator", { actor: moderator });
    const second = await hideWork(t.db, workId, "moderator", { actor: moderator });
    expect([first, second]).toEqual([true, false]);
    expect(await rowsFor(workId)).toHaveLength(1);
  });

  it("A moderator's hide of a work hidden for another cause is logged", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    expect(await hideWork(t.db, workId, "moderator", { actor: moderator })).toBe(true);
    expect(await rowsFor(workId)).toHaveLength(1);
  });

  it("The automatic hide, with no moderator, writes no row", async () => {
    const { workId } = await seedWork(t.db);
    expect(await hideWork(t.db, workId, "reports")).toBe(true);
    expect(await rowsFor(workId)).toEqual([]);
  });

  it("A failure after the action rolls the action and its row back", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db);
    await expect(
      t.db.transaction().execute(async (trx) => {
        await hideWork(trx, workId, "moderator", { actor: moderator });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await state(workId)).status).toBe("live");
    expect(await rowsFor(workId)).toEqual([]);
  });

  it("A row that cannot be written rolls the action back", async () => {
    const { workId } = await seedWork(t.db);
    await expect(
      hideWork(t.db, workId, "moderator", { actor: "modlog-no-such-user" }),
    ).rejects.toThrow();
    expect((await state(workId)).status).toBe("live");

    const hidden = await seedWork(t.db, { status: "hidden", hiddenCause: "moderator" });
    await expect(
      restoreWork(t.db, hidden.workId, { actor: "modlog-no-such-user" }),
    ).rejects.toThrow();
    expect((await state(hidden.workId)).status).toBe("hidden");
  });

  it("A restore inside a caller's transaction joins it", async () => {
    const moderator = await addUser();
    const { workId } = await seedWork(t.db, { status: "hidden", hiddenCause: "moderator" });
    await expect(
      t.db.transaction().execute(async (trx) => {
        expect(await restoreWork(trx, workId, { actor: moderator })).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await state(workId)).status).toBe("hidden");
    expect(await rowsFor(workId)).toEqual([]);
  });

  it("The helper writes a row for any action and target", async () => {
    const moderator = await addUser();
    await logModerationAction(t.db, {
      moderatorId: moderator,
      action: "reject",
      targetKind: "request",
      targetId: "modlog-request-1",
      note: "not the author",
    });
    expect(await rowsFor("modlog-request-1")).toMatchObject([
      { moderator_id: moderator, action: "reject", target_kind: "request", note: "not the author" },
    ]);
  });

  it("A blank or overlong note is refused", async () => {
    const moderator = await addUser();
    const entry = {
      moderatorId: moderator,
      action: "reject",
      targetKind: "request",
      targetId: "modlog-request-2",
    } as const;
    await expect(logModerationAction(t.db, { ...entry, note: "  " })).rejects.toThrow(RangeError);
    await expect(logModerationAction(t.db, { ...entry, note: "x".repeat(201) })).rejects.toThrow(
      RangeError,
    );
    expect(await rowsFor("modlog-request-2")).toEqual([]);
  });

  it("The table has the columns and the migration keeps them", async () => {
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'moderation_actions' order by column_name`.execute(t.db);
    expect(rows.map((r) => r.column_name)).toEqual([
      "action",
      "created_at",
      "id",
      "moderator_id",
      "note",
      "target_id",
      "target_kind",
    ]);
  });
});
