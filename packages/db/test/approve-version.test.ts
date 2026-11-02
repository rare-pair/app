import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveVersion, closeWrongVersionReports, getLiveWork } from "../src/index";
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
async function addModerator() {
  const id = `approve-mod-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true, role: "moderator" })
    .execute();
  return id;
}

const logOf = (targetId: string) =>
  t.db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id", "note"])
    .where("target_id", "=", targetId)
    .execute();

const versionRow = (id: string) =>
  t.db
    .selectFrom("work_versions")
    .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
    .select([
      "work_versions.checked_at",
      "work_versions.hold_reason",
      "uploads.status as upload_status",
    ])
    .where("work_versions.id", "=", id)
    .executeTakeFirstOrThrow();

const currentOf = async (workId: string) =>
  (
    await t.db
      .selectFrom("works")
      .select("current_version_id")
      .where("id", "=", workId)
      .executeTakeFirstOrThrow()
  ).current_version_id;

const openReports = async (workId: string, kind = "wrong_version") =>
  (
    await t.db
      .selectFrom("reports")
      .select("id")
      .where("work_id", "=", workId)
      .where("kind", "=", kind)
      .where("status", "=", "open")
      .execute()
  ).length;

const report = (work: { workId: string; userId: string }, kind: string, status = "open") =>
  t.db
    .insertInto("reports")
    .values({ work_id: work.workId, reporter_id: work.userId, kind, status })
    .execute();

/** A work live at v1 with a held v2 that has its own title and review reasons. */
async function heldWork(marker: string) {
  const first = await seedWork(t.db, { title: `${marker}first` });
  const held = await seedVersion(t.db, first, {
    current: false,
    title: `${marker}second`,
    reviewReasons: ["chapters_changed"],
    chapters: [{ words: 40 }, { words: 60 }],
  });
  return { ...first, v1: first.versionId, v2: held.versionId };
}

describe("18 moderation: Works to check", () => {
  it("Approving a held version publishes it", async () => {
    const moderator = await addModerator();
    const w = await heldWork("apheld");
    await report(w, "wrong_version");

    const outcome = await approveVersion(t.db, w.workId, w.v2, { actor: moderator });

    expect(outcome).toBe("published");
    expect(await currentOf(w.workId)).toBe(w.v2);
    const live = await getLiveWork(t.db, w.ao3WorkId);
    expect(live?.version.id).toBe(w.v2);
    expect(live?.work).toMatchObject({ title: "apheldsecond", words: 100, chapters_count: 2 });
    const row = await versionRow(w.v2);
    expect(row.upload_status).toBe("live");
    // The hold reason stays as history; the upload's status is the state.
    expect(row.hold_reason).toBe("chapters_changed");
    // Checked, so the work leaves Works to check although it carries review reasons.
    expect(row.checked_at).not.toBeNull();
    // The pointer moved, so the reports about the replaced version are closed.
    expect(await openReports(w.workId)).toBe(0);
    // One log row: the approve, and no make_current.
    expect(await logOf(w.v2)).toEqual([
      {
        moderator_id: moderator,
        action: "approve",
        target_kind: "version",
        target_id: w.v2,
        note: null,
      },
    ]);
  });

  it("Approving a held version twice changes nothing the second time", async () => {
    const moderator = await addModerator();
    const w = await heldWork("aptwice");
    expect(await approveVersion(t.db, w.workId, w.v2, { actor: moderator })).toBe("published");
    const before = await versionRow(w.v2);

    expect(await approveVersion(t.db, w.workId, w.v2, { actor: moderator })).toBe("nothing");

    expect(await versionRow(w.v2)).toEqual(before);
    expect(await logOf(w.v2)).toHaveLength(1);
  });

  it("Approving a flagged work clears the notice", async () => {
    const moderator = await addModerator();
    const w = await seedWork(t.db, { title: "apflag", reviewReasons: ["images_dropped"] });

    expect(await approveVersion(t.db, w.workId, w.versionId, { actor: moderator })).toBe("cleared");

    const live = await getLiveWork(t.db, w.ao3WorkId);
    expect(live?.version.checked_at).not.toBeNull();
    expect(await currentOf(w.workId)).toBe(w.versionId);
    expect(await logOf(w.versionId)).toEqual([
      {
        moderator_id: moderator,
        action: "approve",
        target_kind: "version",
        target_id: w.versionId,
        note: null,
      },
    ]);
    // A second approval changes nothing and logs nothing.
    const checked = (await versionRow(w.versionId)).checked_at;
    expect(await approveVersion(t.db, w.workId, w.versionId, { actor: moderator })).toBe("nothing");
    expect((await versionRow(w.versionId)).checked_at).toEqual(checked);
    expect(await logOf(w.versionId)).toHaveLength(1);
  });

  it("Approving a hidden work's flagged version clears it", async () => {
    const moderator = await addModerator();
    const w = await seedWork(t.db, { title: "aphidden", reviewReasons: ["images_dropped"] });
    await t.db
      .updateTable("works")
      .set({ status: "hidden", hidden_cause: "moderator" })
      .where("id", "=", w.workId)
      .execute();

    expect(await approveVersion(t.db, w.workId, w.versionId, { actor: moderator })).toBe("cleared");
  });

  it("Approving a version with nothing to approve changes nothing", async () => {
    const moderator = await addModerator();
    // A live current version without review reasons, and a replaced one with unchecked reasons.
    const plain = await seedWork(t.db, { title: "applain" });
    const flagged = await seedWork(t.db, { title: "apreplaced", reviewReasons: ["x"] });
    const replacement = await seedVersion(t.db, flagged, {});
    const other = await seedWork(t.db, { title: "apother", reviewReasons: ["x"] });

    expect(await approveVersion(t.db, plain.workId, plain.versionId, { actor: moderator })).toBe(
      "nothing",
    );
    expect(
      await approveVersion(t.db, flagged.workId, flagged.versionId, { actor: moderator }),
    ).toBe("nothing");
    // Another work's version.
    expect(await approveVersion(t.db, plain.workId, other.versionId, { actor: moderator })).toBe(
      "nothing",
    );
    expect(await currentOf(flagged.workId)).toBe(replacement.versionId);
    expect((await versionRow(flagged.versionId)).checked_at).toBeNull();
    expect((await versionRow(other.versionId)).checked_at).toBeNull();
    for (const id of [plain.versionId, flagged.versionId, other.versionId]) {
      expect(await logOf(id), id).toEqual([]);
    }
  });

  it("Approving on a removed work is refused and writes nothing", async () => {
    const moderator = await addModerator();
    const w = await heldWork("aprem");
    await t.db.updateTable("works").set({ status: "removed" }).where("id", "=", w.workId).execute();

    expect(await approveVersion(t.db, w.workId, w.v2, { actor: moderator })).toBe("unavailable");

    expect((await versionRow(w.v2)).upload_status).toBe("held_for_review");
    expect((await versionRow(w.v2)).checked_at).toBeNull();
    expect(await currentOf(w.workId)).toBe(w.v1);
    expect(await logOf(w.v2)).toEqual([]);
  });

  it("A failed approval inside a wrapping transaction leaves nothing behind", async () => {
    const moderator = await addModerator();
    const w = await heldWork("aproll");

    await expect(
      t.db.transaction().execute(async (trx) => {
        expect(await approveVersion(trx, w.workId, w.v2, { actor: moderator })).toBe("published");
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");

    expect((await versionRow(w.v2)).upload_status).toBe("held_for_review");
    expect(await currentOf(w.workId)).toBe(w.v1);
    expect(await logOf(w.v2)).toEqual([]);
  });
});

describe("18 moderation: wrong-version reports", () => {
  it("Closing wrong-version reports closes only that kind, and logs once", async () => {
    const moderator = await addModerator();
    const w = await seedWork(t.db, { title: "apclose" });
    await report(w, "wrong_version");
    await report(w, "wrong_version");
    await report(w, "wrong_version", "closed");
    await report(w, "other_kind");

    expect(await closeWrongVersionReports(t.db, w.workId, { actor: moderator })).toBe(2);

    expect(await openReports(w.workId)).toBe(0);
    expect(await openReports(w.workId, "other_kind")).toBe(1);
    expect(await logOf(w.workId)).toEqual([
      {
        moderator_id: moderator,
        action: "reject",
        target_kind: "work",
        target_id: w.workId,
        note: "wrong_version reports",
      },
    ]);
    // A removed work's reports stay as they are.
    const gone = await seedWork(t.db, { title: "apclosegone" });
    await report(gone, "wrong_version");
    await t.db
      .updateTable("works")
      .set({ status: "removed" })
      .where("id", "=", gone.workId)
      .execute();
    expect(await closeWrongVersionReports(t.db, gone.workId, { actor: moderator })).toBe(0);
    expect(await openReports(gone.workId)).toBe(1);
    expect(await logOf(gone.workId)).toEqual([]);
    // Nothing left to close: nothing changes, nothing is logged.
    expect(await closeWrongVersionReports(t.db, w.workId, { actor: moderator })).toBe(0);
    expect(await logOf(w.workId)).toHaveLength(1);
  });
});
