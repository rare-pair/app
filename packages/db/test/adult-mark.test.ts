import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dismissReport,
  getLiveWork,
  hideWork,
  listRecentLiveWorks,
  makeVersionCurrent,
  markAdult,
  unmarkAdult,
} from "../src/index";
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
  const id = `adult-mark-user-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

const report = async (workId: string, reporter: string, kind: string) =>
  (
    await t.db
      .insertInto("reports")
      .values({ work_id: workId, reporter_id: reporter, kind })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;

const statusOf = async (id: string) =>
  (await t.db.selectFrom("reports").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const logFor = (targetId: string) =>
  t.db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id"])
    .where("target_id", "=", targetId)
    .execute();

describe("17-reports-and-dmca", () => {
  it("Needs-a-higher-rating reports never count toward hiding", async () => {
    const { workId } = await seedWork(t.db);
    const [u, u2, u3] = [await addUser(), await addUser(), await addUser()];
    await report(workId, u, "other");
    await report(workId, u2, "other");
    await report(workId, u3, "higher_rating");
    expect(await hideWork(t.db, workId, "reports", { minReporters: 3 })).toBe(false);
  });
});

describe("18-moderation", () => {
  it("A moderator marks a work as adult", async () => {
    const { workId, ao3WorkId } = await seedWork(t.db, { rating: "General Audiences" });
    const moderator = await addUser();
    const closes = await report(workId, await addUser(), "higher_rating");
    const stays = await report(workId, await addUser(), "other");

    const result = await markAdult(t.db, workId, { actor: moderator });

    expect(result).toEqual({ outcome: "changed", closed: 1 });
    const live = await getLiveWork(t.db, ao3WorkId);
    expect(live?.work.adult_marked).toBe(true);
    // The rating still reads as the file gave it.
    expect(live?.work.rating).toBe("General Audiences");
    expect(await statusOf(closes)).toBe("closed");
    expect(await statusOf(stays)).toBe("open");
    expect(await logFor(workId)).toEqual([
      { moderator_id: moderator, action: "mark_adult", target_kind: "work", target_id: workId },
    ]);
  });

  it("Marking a marked work again changes and logs nothing", async () => {
    const { workId } = await seedWork(t.db);
    const moderator = await addUser();
    await markAdult(t.db, workId, { actor: moderator });
    expect(await markAdult(t.db, workId, { actor: moderator })).toEqual({
      outcome: "unchanged",
      closed: 0,
    });
    expect(await logFor(workId)).toHaveLength(1);
  });

  it("A moderator removes the adult mark", async () => {
    const { workId, ao3WorkId } = await seedWork(t.db);
    const moderator = await addUser();
    await markAdult(t.db, workId, { actor: moderator });

    expect(await unmarkAdult(t.db, workId, { actor: moderator })).toBe("changed");

    expect((await getLiveWork(t.db, ao3WorkId))?.work.adult_marked).toBe(false);
    expect((await logFor(workId)).map((row) => row.action)).toEqual(["mark_adult", "unmark_adult"]);
    expect(await unmarkAdult(t.db, workId, { actor: moderator })).toBe("unchanged");
    expect(await logFor(workId)).toHaveLength(2);
  });

  it("A removed work can't be marked", async () => {
    const { workId } = await seedWork(t.db, { status: "removed" });
    expect(await markAdult(t.db, workId, { actor: await addUser() })).toEqual({
      outcome: "unavailable",
      closed: 0,
    });
  });

  it("A new version or a rollback keeps the adult mark", async () => {
    const first = await seedWork(t.db, { rating: "General Audiences" });
    const moderator = await addUser();
    await markAdult(t.db, first.workId, { actor: moderator });
    const second = await seedVersion(t.db, first, { rating: "Teen And Up Audiences" });
    expect((await getLiveWork(t.db, first.ao3WorkId))?.work.adult_marked).toBe(true);
    await makeVersionCurrent(t.db, first.workId, first.versionId, { actor: moderator });
    expect((await getLiveWork(t.db, first.ao3WorkId))?.work.adult_marked).toBe(true);
    expect(second.versionId).not.toBe(first.versionId);
  });

  it("A card's work carries the mark with no query of its own", async () => {
    const { workId, ao3WorkId } = await seedWork(t.db);
    await markAdult(t.db, workId, { actor: await addUser() });
    const listed = await listRecentLiveWorks(t.db, 500);
    expect(listed.find((l) => l.work.ao3_work_id === ao3WorkId)?.work.adult_marked).toBe(true);
  });

  it("A higher-rating report can be dismissed", async () => {
    const { workId } = await seedWork(t.db);
    const id = await report(workId, await addUser(), "higher_rating");
    expect(await dismissReport(t.db, id, { actor: await addUser() })).toBe("dismissed");
  });
});
