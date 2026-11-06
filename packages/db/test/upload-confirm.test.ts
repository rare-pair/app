import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteOpenUpload,
  getUploadOf,
  insertUpload,
  recordUploadHash,
  type UploadStatus,
} from "../src/index";
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

const HASH = "a".repeat(64);

// A pending upload by a fresh user, as POST /uploads leaves it.
async function pendingUpload() {
  const w = await seedWork(t.db, {});
  const { id } = await insertUpload(t.db, {
    userId: w.userId,
    r2Key: `uploads/${crypto.randomUUID()}`,
    bytes: 10,
  });
  return { id, userId: w.userId };
}

const rowOf = (id: string) =>
  t.db
    .selectFrom("uploads")
    .select(["status", "work_id", "sha256"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const setEarlier = (id: string, sha256: string, status?: UploadStatus) =>
  t.db
    .updateTable("uploads")
    .set(status === undefined ? { sha256 } : { sha256, status })
    .where("id", "=", id)
    .execute();

describe("02-upload-handshake: confirming an upload", () => {
  it("finds an upload by id and owner only", async () => {
    const up = await pendingUpload();
    const other = await seedWork(t.db, {});
    expect(await getUploadOf(t.db, up.id, up.userId)).toMatchObject({
      id: up.id,
      status: "pending",
    });
    expect(await getUploadOf(t.db, up.id, other.userId)).toBeNull();
    expect(await getUploadOf(t.db, "no-such-upload", up.userId)).toBeNull();
  });

  it("Confirm marks a byte-identical re-upload as duplicate, of a live or hidden work", async () => {
    for (const status of ["live", "hidden"] as const) {
      const earlier = await seedWork(t.db, {
        status,
        hiddenCause: status === "hidden" ? "moderator" : undefined,
      });
      const hash = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
      await setEarlier(earlier.uploadId, hash);
      const up = await pendingUpload();
      expect(await recordUploadHash(t.db, up.id, hash)).toEqual({ duplicateOf: earlier.workId });
      expect(await rowOf(up.id)).toEqual({
        status: "duplicate",
        work_id: earlier.workId,
        sha256: hash,
      });
    }
  });

  it("A hash match on a held_for_review earlier upload is marked duplicate", async () => {
    const earlier = await seedWork(t.db, {});
    const hash = "b".repeat(64);
    await setEarlier(earlier.uploadId, hash, "held_for_review");
    const up = await pendingUpload();
    expect(await recordUploadHash(t.db, up.id, hash)).toEqual({ duplicateOf: earlier.workId });
  });

  it("Hash matches that get no shortcut: pending, processing, rejected, removed work", async () => {
    // Each earlier upload belongs to a live work, so only its status keeps it from matching:
    // a match on the join alone would be a bug these cases catch.
    const cases: [string, "live" | "removed", UploadStatus][] = [
      ["removed work", "removed", "live"],
      ["pending", "live", "pending"],
      ["processing", "live", "processing"],
      ["rejected", "live", "not_ao3"],
    ];
    for (const [i, [name, workStatus, status]] of cases.entries()) {
      const earlier = await seedWork(t.db, { status: workStatus });
      const hash = String(i + 1).repeat(64);
      await setEarlier(earlier.uploadId, hash, status);
      const up = await pendingUpload();
      expect(await recordUploadHash(t.db, up.id, hash), name).toEqual({ duplicateOf: null });
      expect(await rowOf(up.id), name).toEqual({ status: "pending", work_id: null, sha256: hash });
    }
  });

  it("A hash with no match is stored and the upload stays pending", async () => {
    const up = await pendingUpload();
    expect(await recordUploadHash(t.db, up.id, HASH)).toEqual({ duplicateOf: null });
    expect(await rowOf(up.id)).toEqual({ status: "pending", work_id: null, sha256: HASH });
  });

  it("Records nothing for an upload that is no longer pending", async () => {
    const up = await pendingUpload();
    await t.db
      .updateTable("uploads")
      .set({ status: "processing" })
      .where("id", "=", up.id)
      .execute();
    expect(await recordUploadHash(t.db, up.id, HASH)).toBeNull();
    expect((await rowOf(up.id)).sha256).toBeNull();
  });
});

describe("02-upload-handshake: freeing an open upload's slot", () => {
  const keyOf = async (id: string) =>
    (await t.db.selectFrom("uploads").select("r2_key").where("id", "=", id).executeTakeFirst())
      ?.r2_key;

  it("deletes the owner's open upload and returns its key", async () => {
    const up = await pendingUpload();
    const key = await keyOf(up.id);
    expect(await deleteOpenUpload(t.db, up.id, up.userId)).toBe(key);
    expect(await getUploadOf(t.db, up.id, up.userId)).toBeNull();
  });

  it("leaves another user's upload alone", async () => {
    const up = await pendingUpload();
    const other = await seedWork(t.db, {});
    expect(await deleteOpenUpload(t.db, up.id, other.userId)).toBeNull();
    expect(await getUploadOf(t.db, up.id, up.userId)).not.toBeNull();
  });

  it("leaves an upload a confirm has counted alone", async () => {
    const up = await pendingUpload();
    await t.db
      .updateTable("uploads")
      .set({ quota_counted_at: new Date() })
      .where("id", "=", up.id)
      .execute();
    expect(await deleteOpenUpload(t.db, up.id, up.userId)).toBeNull();
    expect(await getUploadOf(t.db, up.id, up.userId)).not.toBeNull();
  });

  it.each(["processing", "duplicate", "over_quota", "account_banned"] as const)(
    "leaves a %s upload alone",
    async (status) => {
      const up = await pendingUpload();
      await t.db.updateTable("uploads").set({ status }).where("id", "=", up.id).execute();
      expect(await deleteOpenUpload(t.db, up.id, up.userId)).toBeNull();
      expect(await getUploadOf(t.db, up.id, up.userId)).not.toBeNull();
    },
  );

  it("gives the key to only one of two deletes", async () => {
    const up = await pendingUpload();
    const key = await keyOf(up.id);
    const results = await Promise.all([
      deleteOpenUpload(t.db, up.id, up.userId),
      deleteOpenUpload(t.db, up.id, up.userId),
    ]);
    expect(results.filter((r) => r === key)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});
