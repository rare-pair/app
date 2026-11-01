import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { banUser, insertUpload, isBanned, type UploadStatus } from "../src/index";
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
async function addUser(role: string | null = null) {
  const id = `ban-user-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true, role })
    .execute();
  return id;
}

/** An upload by `userId` left with `status`, as the pipeline would leave it. */
async function uploadWith(userId: string, status: UploadStatus) {
  const { id } = await insertUpload(t.db, {
    userId,
    r2Key: `uploads/${crypto.randomUUID()}`,
    bytes: 10,
  });
  await t.db.updateTable("uploads").set({ status }).where("id", "=", id).execute();
  return id;
}

const statusOf = async (uploadId: string) =>
  (
    await t.db
      .selectFrom("uploads")
      .select("status")
      .where("id", "=", uploadId)
      .executeTakeFirstOrThrow()
  ).status;

const bannedAt = async (userId: string) =>
  (
    await t.db
      .selectFrom("user")
      .select("banned_at")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow()
  ).banned_at;

const logFor = (userId: string) =>
  t.db.selectFrom("moderation_actions").selectAll().where("target_id", "=", userId).execute();

describe("18-moderation: Moderator bans an uploader", () => {
  it("A ban sets banned_at, ends pending uploads as account_banned and logs it", async () => {
    const moderator = await addUser("moderator");
    const { userId, uploadId: liveUpload, workId } = await seedWork(t.db);
    const pending = await uploadWith(userId, "pending");

    expect(await banUser(t.db, userId, { actor: moderator })).toBe("banned");

    expect(await bannedAt(userId)).toBeInstanceOf(Date);
    expect(await isBanned(t.db, userId)).toBe(true);
    expect(await statusOf(pending)).toBe("account_banned");
    // Z's live work and its finished upload stay as they are.
    expect(await statusOf(liveUpload)).toBe("live");
    const work = await t.db
      .selectFrom("works")
      .select("status")
      .where("id", "=", workId)
      .executeTakeFirstOrThrow();
    expect(work.status).toBe("live");
    const rows = await logFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      moderator_id: moderator,
      action: "ban",
      target_kind: "user",
      target_id: userId,
      note: null,
    });
  });

  it("Only pending uploads end as account_banned: ingest ends processing ones", async () => {
    const moderator = await addUser("moderator");
    const userId = await addUser();
    const kept: [string, UploadStatus][] = [];
    for (const status of ["processing", "held_for_review", "duplicate", "not_epub"] as const) {
      kept.push([await uploadWith(userId, status), status]);
    }

    expect(await banUser(t.db, userId, { actor: moderator })).toBe("banned");

    for (const [id, status] of kept) expect(await statusOf(id)).toBe(status);
  });

  it("A second ban changes nothing and writes no second row", async () => {
    const moderator = await addUser("moderator");
    const userId = await addUser();
    expect(await banUser(t.db, userId, { actor: moderator })).toBe("banned");
    const first = await bannedAt(userId);
    const later = await uploadWith(userId, "pending");

    expect(await banUser(t.db, userId, { actor: moderator })).toBe("already_banned");

    expect(await bannedAt(userId)).toEqual(first);
    expect(await logFor(userId)).toHaveLength(1);
    // Nothing of a no-op is written: a row inserted since is left to the upload routes.
    expect(await statusOf(later)).toBe("pending");
  });

  it("An unknown account is not found", async () => {
    const moderator = await addUser("moderator");
    expect(await banUser(t.db, "ban-nobody", { actor: moderator })).toBe("not_found");
    expect(await logFor("ban-nobody")).toEqual([]);
  });

  it("A moderator can't ban themselves, another moderator or an admin", async () => {
    const moderator = await addUser("moderator");
    const other = await addUser("moderator");
    const admin = await addUser("admin");
    for (const target of [moderator, other, admin]) {
      const pending = await uploadWith(target, "pending");
      expect(await banUser(t.db, target, { actor: moderator })).toBe("protected");
      expect(await bannedAt(target)).toBeNull();
      expect(await statusOf(pending)).toBe("pending");
      expect(await logFor(target)).toEqual([]);
    }
  });

  it("A ban in a transaction that rolls back leaves no effect", async () => {
    const moderator = await addUser("moderator");
    const userId = await addUser();
    const pending = await uploadWith(userId, "pending");

    await expect(
      t.db.transaction().execute(async (trx) => {
        expect(await banUser(trx, userId, { actor: moderator })).toBe("banned");
        throw new Error("after the ban");
      }),
    ).rejects.toThrow("after the ban");

    expect(await bannedAt(userId)).toBeNull();
    expect(await statusOf(pending)).toBe("pending");
    expect(await logFor(userId)).toEqual([]);
  });

  it("An account with no row counts as banned", async () => {
    expect(await isBanned(t.db, "ban-no-such-account")).toBe(true);
  });

  it("An account that was never banned is not banned", async () => {
    expect(await isBanned(t.db, await addUser())).toBe(false);
  });
});
