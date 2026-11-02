import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfill } from "../../../scripts/backfill.mjs";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

// The operator's backfill script (scripts/backfill.mjs), run against the real migrations on
// PGlite, with the Cloudflare Queues HTTP call stubbed at fetch. maxConnections: 2 is `db`
// plus the script's client.
let t: TestDb;
const current = new Map<string, string>();
let removedId: string;
let processingId: string;
beforeAll(async () => {
  t = await createTestDb({ maxConnections: 2 });
  for (const options of [{}, {}, {}, { status: "hidden", hiddenCause: "moderator" }] as const) {
    const work = await seedWork(t.db, options);
    current.set(work.workId, work.versionId);
  }
  removedId = (await seedWork(t.db, { status: "removed" })).workId;
  // Still processing: no current version yet.
  const processing = await t.db
    .insertInto("works")
    .values({ ao3_work_id: 999_999, title: "t", chapters_count: 0, complete: false })
    .returning("id")
    .executeTakeFirstOrThrow();
  processingId = processing.id;
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

interface Pushed {
  url: string;
  authorization: string | null;
  messages: { body: { work_id: string; version_id: string }; content_type: string }[];
}

const ok = () => Response.json({ success: true, errors: [], messages: [], result: {} });

/** A fetch that records each push; `answer` decides each one's reply by its 0-based index. */
function queueStub(answer: (call: number) => Response | Error = () => ok()) {
  const pushed: Pushed[] = [];
  const stub: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    // SAFETY: the script sends a JSON string body, in the shape Pushed describes.
    const body = JSON.parse(init?.body as string) as Pick<Pushed, "messages">;
    pushed.push({
      url: input instanceof Request ? input.url : input.toString(),
      authorization: headers.get("authorization"),
      messages: body.messages,
    });
    const reply = answer(pushed.length - 1);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { stub, pushed };
}

const options = (
  stub: typeof fetch,
  extra: { batchSize?: number; after?: string | null } = {},
) => ({
  connectionString: t.connectionString,
  accountId: "test-account",
  queueId: "test-queue",
  apiToken: "test-token",
  fetch: stub,
  log: () => {},
  ...extra,
});

const bodies = (pushed: Pushed[]) => pushed.flatMap((p) => p.messages.map((m) => m.body));
const expected = () =>
  [...current]
    .map(([work_id, version_id]) => ({ work_id, version_id }))
    .sort((a, b) => (a.work_id < b.work_id ? -1 : 1));

describe("07-sanitizing-and-images", () => {
  it("Every live or hidden work's current version is queued for the backfill", async () => {
    const { stub, pushed } = queueStub();

    const result = await backfill(options(stub, { batchSize: 3 }));

    expect(result).toMatchObject({ queued: 4, done: true, error: null });
    expect(bodies(pushed)).toEqual(expected());
    const workIds = bodies(pushed).map((b) => b.work_id);
    expect(workIds).not.toContain(removedId);
    expect(workIds).not.toContain(processingId);
    expect(pushed.map((p) => p.messages.length)).toEqual([3, 1]);
    expect(pushed[0]).toMatchObject({
      url: "https://api.cloudflare.com/client/v4/accounts/test-account/queues/test-queue/messages/batch",
      authorization: "Bearer test-token",
    });
    expect(pushed[0]?.messages[0]?.content_type).toBe("json");
  });

  it("A failed push stops the run, and a rerun after its last work queues the rest", async () => {
    const failing = queueStub((call) => (call === 1 ? new Response("", { status: 500 }) : ok()));

    const stopped = await backfill(options(failing.stub, { batchSize: 2 }));

    const all = expected();
    expect(stopped).toEqual({ queued: 2, after: all[1]?.work_id, done: false, error: "HTTP 500" });
    const rest = queueStub();
    const resumed = await backfill(options(rest.stub, { after: stopped.after }));
    expect(resumed).toMatchObject({ queued: 2, done: true, error: null });
    expect(bodies(rest.pushed)).toEqual(all.slice(2));
  });

  it("A stop during a push says the batch may or may not be queued", async () => {
    const stop = new AbortController();
    const { stub } = queueStub(() => {
      stop.abort();
      return new DOMException("aborted", "AbortError");
    });

    const result = await backfill({ ...options(stub), signal: stop.signal });

    expect(result).toMatchObject({ queued: 0, done: false });
    expect(result.error).toMatch(/^interrupted during a push of 4 works/);
  });

  it("A queue id with a path in it stays one segment of the API URL", async () => {
    const { stub, pushed } = queueStub();

    await backfill({ ...options(stub, { batchSize: 100 }), queueId: "q/../../zones?x" });

    expect(pushed[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account/queues/q%2F..%2F..%2Fzones%3Fx/messages/batch",
    );
  });

  it("An unreachable database is reported by its code, never its connection string", async () => {
    const { stub, pushed } = queueStub();

    const result = await backfill({
      ...options(stub),
      connectionString: "postgresql://nobody:not-a-password@127.0.0.1:1/none",
    });

    expect(result.done).toBe(false);
    expect(result.error).toMatch(/^database error \(\w+\)$/);
    expect(result.error).not.toContain("not-a-password");
    expect(pushed).toEqual([]);
  });
});
