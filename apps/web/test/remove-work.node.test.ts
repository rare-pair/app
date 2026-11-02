import { seedWork } from "@archive/db/seed";
import { createTestDb, type TestDb } from "@archive/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PurgeError, type PurgeTarget } from "../src/purge";
import type { ObjectBucket } from "../src/remove-objects";
import { removeWorkEverywhere } from "../src/remove-work";

// The one remove, in order: the status, then R2, then the cache purge. Cloudflare's purge API
// is the stub (the workerd tests in 18-work-remove.test.ts cover the route and its requests);
// R2 is an in-memory bucket, so a delete can be made to fail.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
}, 60_000);

/** An in-memory bucket holding `keys`; `failDelete` makes every delete throw. */
function memoryBucket(keys: string[], failDelete = false) {
  const held = new Set(keys);
  const bucket: ObjectBucket = {
    async list({ prefix }) {
      return {
        objects: [...held].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(toDelete) {
      if (failDelete) throw new Error("R2 unavailable");
      for (const k of toDelete) held.delete(k);
    },
  };
  return { bucket, held };
}

/** A purge stand-in recording each target with the keys the bucket held at that moment. */
function recordingPurge(held: Set<string>, fail = false) {
  const calls: { target: PurgeTarget; heldThen: string[] }[] = [];
  const purge = async (target: PurgeTarget) => {
    calls.push({ target, heldThen: [...held].sort() });
    if (fail) throw new PurgeError("cache purge failed: tags (HTTP 503)");
  };
  return { calls, purge };
}

/** A seeded work and its objects in R2. */
async function seeded(ao3WorkId: number, status: "live" | "processing" = "live") {
  const work = await seedWork(t.db, { ao3WorkId, status });
  const keys = [
    `works/${ao3WorkId}/${work.uploadId}/00001.html`,
    `works/${ao3WorkId}/img/${"ab".repeat(32)}`,
    `originals/${work.uploadId}.epub`,
  ];
  return { work, keys };
}

describe("removeWorkEverywhere", () => {
  it(
    "Removes the work, deletes its files, then purges its caches",
    { timeout: 30_000 },
    async () => {
      const { work, keys } = await seeded(14501);
      const { bucket, held } = memoryBucket(keys);
      const { calls, purge } = recordingPurge(held);
      const result = await removeWorkEverywhere(
        { db: t.db, bucket, purge },
        work.workId,
        work.userId,
      );
      expect(result).toEqual({ outcome: "removed", caches: "purged" });
      // Asked once, for the work and its upload, after the bucket was emptied.
      expect(calls).toEqual([
        { target: { ao3WorkId: 14501, uploadIds: [work.uploadId] }, heldThen: [] },
      ]);
    },
  );

  it(
    "A failed purge leaves the work removed and its files deleted, and says so",
    { timeout: 30_000 },
    async () => {
      const { work, keys } = await seeded(14502);
      const { bucket, held } = memoryBucket(keys);
      const { purge } = recordingPurge(held, true);
      const logged: unknown[][] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => logged.push(args);
      let result;
      try {
        result = await removeWorkEverywhere({ db: t.db, bucket, purge }, work.workId, work.userId);
      } finally {
        console.error = error;
      }
      expect(result).toEqual({ outcome: "removed", caches: "failed" });
      expect(held.size).toBe(0);
      const status = await t.db
        .selectFrom("works")
        .select("status")
        .where("id", "=", work.workId)
        .executeTakeFirstOrThrow();
      expect(status.status).toBe("removed");
      // The step and the error's name only: no work, no keys, no reply.
      expect(logged).toEqual([["remove work: cache purge failed:", "PurgeError"]]);
    },
  );

  it("A failed delete skips the purge", { timeout: 30_000 }, async () => {
    const { work, keys } = await seeded(14503);
    const { bucket, held } = memoryBucket(keys, true);
    const { calls, purge } = recordingPurge(held);
    await expect(
      removeWorkEverywhere({ db: t.db, bucket, purge }, work.workId, work.userId),
    ).rejects.toThrow("R2 unavailable");
    expect(calls).toEqual([]);
  });

  it(
    "A repeat remove deletes and purges again; a processing work is left alone",
    { timeout: 30_000 },
    async () => {
      const { work, keys } = await seeded(14504);
      const first = memoryBucket(keys);
      await removeWorkEverywhere(
        { db: t.db, bucket: first.bucket, purge: recordingPurge(first.held).purge },
        work.workId,
        work.userId,
      );
      const again = memoryBucket(keys);
      const repeat = recordingPurge(again.held);
      expect(
        await removeWorkEverywhere(
          { db: t.db, bucket: again.bucket, purge: repeat.purge },
          work.workId,
          work.userId,
        ),
      ).toEqual({ outcome: "already_removed", caches: "purged" });
      expect(again.held.size).toBe(0);
      expect(repeat.calls).toHaveLength(1);

      const processing = await seeded(14505, "processing");
      const untouched = memoryBucket(processing.keys);
      const none = recordingPurge(untouched.held);
      expect(
        await removeWorkEverywhere(
          { db: t.db, bucket: untouched.bucket, purge: none.purge },
          processing.work.workId,
          processing.work.userId,
        ),
      ).toEqual({ outcome: "processing" });
      expect(untouched.held.size).toBe(3);
      expect(none.calls).toEqual([]);
    },
  );
});
