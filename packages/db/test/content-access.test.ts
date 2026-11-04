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

  it("Refuses a held version's upload, whether its work is live or hidden", async () => {
    const work = await seedWork(t.db);
    const held = await seedVersion(t.db, work, { current: false });
    expect(await getOriginalAccess(t.db, held.uploadId)).toBe("refuse");
    await hideWork(t.db, work.workId, "moderator");
    expect(await getOriginalAccess(t.db, held.uploadId)).toBe("refuse");
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

/** Runs an image-access read against a fake server, and returns how it failed and how long it took. */
async function readAgainst(
  onConnection: (socket: net.Socket) => void,
  timeouts: { connect: number; query: number },
) {
  const server = net.createServer((socket) => {
    // The client tears the connection down when it gives up: a reset is expected.
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // SAFETY: a server listening on a port has an address object, not a pipe path.
  const { port } = server.address() as net.AddressInfo;
  const db = createDb({
    connectionString: `postgresql://u:p@127.0.0.1:${port}/d`,
    max: 1,
    connectionTimeoutMillis: timeouts.connect,
    queryTimeoutMillis: timeouts.query,
  });
  const started = Date.now();
  try {
    const failure = await getImageAccess(db, 1).then(
      () => null,
      (error: Error) => error,
    );
    return { failure, elapsed: Date.now() - started };
  } finally {
    await db.destroy();
    server.close();
  }
}

describe("createDb timeouts", () => {
  it("A server that never answers fails the read within the connection timeout", async () => {
    // Accepts connections and says nothing, as a database that has stopped responding does.
    // The query timeout is long, so only the connection timeout can end the read in time.
    const { failure, elapsed } = await readAgainst(() => {}, { connect: 300, query: 10_000 });
    expect(failure).not.toBeNull();
    expect(elapsed).toBeLessThan(3000);
  });

  it("A server that accepts the connection and stalls the query fails the read within the query timeout", async () => {
    // Answers the startup message with "authentication ok" and "ready for query", then says
    // nothing to the query: the connect timeout has nothing to catch, only the query timeout does.
    const { failure, elapsed } = await readAgainst(
      (socket) => {
        socket.once("data", () => {
          const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
          const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
          socket.write(Buffer.concat([authOk, ready]));
        });
      },
      { connect: 5000, query: 300 },
    );
    expect(failure?.message).toMatch(/query read timeout/i);
    expect(elapsed).toBeLessThan(2000);
  });
});
