import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getImageAccess, getOriginalAccess, hideWork } from "../src/index";
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

describe("getImageAccess", () => {
  it("Serves a live work's images and refuses every other state", async () => {
    const live = await seedWork(t.db);
    const hidden = await seedWork(t.db, { status: "hidden", hiddenCause: "reports" });
    const removed = await seedWork(t.db, { status: "removed" });
    expect(await getImageAccess(t.db, live.ao3WorkId)).toBe("serve");
    expect(await getImageAccess(t.db, hidden.ao3WorkId)).toBe("hidden");
    expect(await getImageAccess(t.db, removed.ao3WorkId)).toBe("refuse");
    expect(await getImageAccess(t.db, live.ao3WorkId + 1_000_000_000)).toBe("refuse");
    expect(await getImageAccess(t.db, 2_147_483_648)).toBe("refuse");
    expect(await getImageAccess(t.db, 0)).toBe("refuse");
  });

  it("Refuses a work still processing", async () => {
    const work = await seedWork(t.db);
    await t.db
      .updateTable("works")
      .set({ status: "processing" })
      .where("id", "=", work.workId)
      .execute();
    expect(await getImageAccess(t.db, work.ao3WorkId)).toBe("refuse");
  });
});

describe("getOriginalAccess", () => {
  it("Follows the work's status for a published upload", async () => {
    const work = await seedWork(t.db);
    expect(await getOriginalAccess(t.db, work.uploadId)).toBe("serve");
    await hideWork(t.db, work.workId, "moderator");
    expect(await getOriginalAccess(t.db, work.uploadId)).toBe("hidden");
  });

  it("Refuses a held version's upload, but a hidden work refuses it as hidden", async () => {
    const work = await seedWork(t.db);
    const held = await seedVersion(t.db, work, { current: false });
    expect(await getOriginalAccess(t.db, held.uploadId)).toBe("refuse");
    await hideWork(t.db, work.workId, "moderator");
    expect(await getOriginalAccess(t.db, held.uploadId)).toBe("hidden");
  });

  it("Refuses an unknown upload, an upload with no work, and a removed work's", async () => {
    const work = await seedWork(t.db);
    const id = crypto.randomUUID();
    await t.db
      .insertInto("uploads")
      .values({
        id,
        user_id: work.userId,
        r2_key: `uploads/${id}.epub`,
        sha256: id,
        bytes: 1,
        status: "not_ao3",
      })
      .execute();
    const removed = await seedWork(t.db, { status: "removed" });
    expect(await getOriginalAccess(t.db, id)).toBe("refuse");
    expect(await getOriginalAccess(t.db, crypto.randomUUID())).toBe("refuse");
    expect(await getOriginalAccess(t.db, removed.uploadId)).toBe("refuse");
    // Not a uuid, and not a path: a plain parameter.
    expect(await getOriginalAccess(t.db, "x'; select 1; --")).toBe("refuse");
  });
});

describe("createDb timeouts", () => {
  it("A server that never answers fails the read within the query timeout", async () => {
    // Accepts connections and says nothing, as a database that has stopped responding does.
    const server = net.createServer(() => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    // SAFETY: a server listening on a port has an address object, not a pipe path.
    const { port } = server.address() as net.AddressInfo;
    const db = createDb({
      connectionString: `postgresql://u:p@127.0.0.1:${port}/d`,
      max: 1,
      connectionTimeoutMillis: 300,
      queryTimeoutMillis: 300,
    });
    const started = Date.now();
    try {
      await expect(getImageAccess(db, 1)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await db.destroy();
      server.close();
    }
  });
});
