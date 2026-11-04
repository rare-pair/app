import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchSend } from "../../../scripts/launch-send.mjs";
import { createTestDb, type TestDb } from "../src/testing";

// The operator's script (scripts/launch-send.mjs), run against the real migrations on PGlite,
// with the Cloudflare Queues HTTP call stubbed at fetch. maxConnections: 3 is `db` plus the
// two clients of "two runs at once".
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ maxConnections: 3 });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});
beforeEach(async () => {
  await t.db.deleteFrom("waitlist").execute();
});

const CONFIRMED = new Date("2026-10-01T00:00:00Z");
const confirmed = (n: number) => `c${String(n).padStart(3, "0")}@example.test`;

async function seed(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    email: confirmed(i),
    confirmed_at: CONFIRMED,
  }));
  await t.db.insertInto("waitlist").values(rows).execute();
}

interface Pushed {
  url: string;
  authorization: string | null;
  contentType: string | null;
  messages: { body: { kind: string; to: string; url: string }; content_type: string }[];
}

const ok = () => Response.json({ success: true, errors: [], messages: [], result: {} });
const refused = (code: number) =>
  Response.json({ success: false, errors: [{ code, message: "x@example.test" }] });

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
      contentType: headers.get("content-type"),
      messages: body.messages,
    });
    const reply = answer(pushed.length - 1);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { stub, pushed };
}

interface RunOptions {
  batchSize?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

const options = (stub: typeof fetch, extra: RunOptions = {}) => ({
  connectionString: t.connectionString,
  accountId: "test-account",
  queueId: "test-queue",
  apiToken: "test-token",
  fetch: stub,
  ...extra,
});

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const rowOf = (email: string) =>
  t.db.selectFrom("waitlist").selectAll().where("email", "=", email).executeTakeFirstOrThrow();

describe("22-waitlist launch send script", () => {
  it("The launch send emails each confirmed address once", async () => {
    await seed(5);
    await t.db
      .insertInto("waitlist")
      .values({ email: "unconfirmed@example.test", confirmed_at: null })
      .execute();
    const done = new Date("2026-10-02T00:00:00Z");
    await t.db
      .insertInto("waitlist")
      .values({ email: "done@example.test", confirmed_at: CONFIRMED, notified_at: done })
      .execute();
    const { stub, pushed } = queueStub();
    const lines: string[] = [];

    const result = await launchSend(
      options(stub, { batchSize: 2, log: (l: string) => lines.push(l) }),
    );

    expect(result).toEqual({ queued: 5, remaining: 0, error: null });
    // In batches, to the queue's HTTP API with the token, as JSON.
    expect(pushed.map((p) => p.messages.length)).toEqual([2, 2, 1]);
    for (const p of pushed) {
      expect(p.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/test-account/queues/test-queue/messages/batch",
      );
      expect(p.authorization).toBe("Bearer test-token");
      expect(p.contentType).toBe("application/json");
    }
    const messages = pushed.flatMap((p) => p.messages);
    const queuedTo = messages.map((m) => m.body.to);
    expect([...queuedTo].sort()).toEqual([0, 1, 2, 3, 4].map(confirmed));
    for (const m of messages) {
      expect(m.content_type).toBe("json");
      expect(Object.keys(m.body).sort()).toEqual(["kind", "to", "url"]);
      expect(m.body.kind).toBe("waitlist-launch");
      // What apps/mailer's parseMessage accepts for this kind.
      expect(m.body.url).toMatch(
        /^https:\/\/rarepair\.fans\/waitlist\/unsubscribe\?token=[A-Za-z0-9_-]+$/,
      );
      // 32 random bytes, base64url without padding.
      expect(tokenOf(m.body.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const row = await rowOf(m.body.to);
      expect(row.notified_at).not.toBeNull();
      // Only the hash of the token in that address's link is stored (apps/web's hashToken).
      expect(row.unsubscribe_token_hash).toBe(sha256(tokenOf(m.body.url)));
    }
    expect(new Set(messages.map((m) => tokenOf(m.body.url))).size).toBe(5);
    // Unconfirmed addresses get nothing and keep their row as it was; an address already
    // notified is not queued again and keeps its time.
    expect(queuedTo).not.toContain("unconfirmed@example.test");
    expect(queuedTo).not.toContain("done@example.test");
    const unconfirmed = await rowOf("unconfirmed@example.test");
    expect(unconfirmed.notified_at).toBeNull();
    expect(unconfirmed.unsubscribe_token_hash).toBeNull();
    const already = await rowOf("done@example.test");
    expect(already.notified_at).toEqual(done);
    expect(already.unsubscribe_token_hash).toBeNull();
    // No log line names an address or carries a link or token.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/@|example\.test|rarepair|token=/);
    }
  });

  it("The launch send emails each confirmed address once: a batch whose enqueue fails is picked up again", async () => {
    await seed(5);
    const { stub, pushed } = queueStub((call) => (call === 1 ? refused(10000) : ok()));
    const lines: string[] = [];

    const first = await launchSend(
      options(stub, { batchSize: 2, log: (l: string) => lines.push(l) }),
    );

    // The run stops at the failed push, and says why by code only.
    expect(pushed).toHaveLength(2);
    expect(first.queued).toBe(2);
    expect(first.remaining).toBe(3);
    expect(first.error).toBe("Cloudflare error 10000");
    const sent = pushed[0]!.messages.map((m) => m.body.to);
    const failed = pushed[1]!.messages.map((m) => m.body.to);
    for (const to of sent) expect((await rowOf(to)).notified_at).not.toBeNull();
    for (const to of failed) {
      // Nothing of the failed claim is left: not the time, and not the hash of a token no email carries.
      const row = await rowOf(to);
      expect(row.notified_at).toBeNull();
      expect(row.unsubscribe_token_hash).toBeNull();
    }
    // The unreached address is untouched.
    expect((await rowOf(confirmed(4))).notified_at).toBeNull();
    for (const line of [...lines, first.error ?? ""]) expect(line).not.toMatch(/@|example\.test/);

    // The next run picks up the failed batch and the rest, and nothing already queued.
    const retry = queueStub();
    const second = await launchSend(options(retry.stub, { batchSize: 2 }));
    expect(second).toEqual({ queued: 3, remaining: 0, error: null });
    const again = retry.pushed.flatMap((p) => p.messages.map((m) => m.body.to));
    expect([...again].sort()).toEqual([...failed, confirmed(4)].sort());
    expect(again.filter((to) => sent.includes(to))).toEqual([]);
  });

  it("The launch send emails each confirmed address once: a push that throws or answers an error status also clears its batch", async () => {
    await seed(2);
    const thrown = queueStub(() => new TypeError("connect ECONNREFUSED a@example.test"));
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const first = await launchSend(options(thrown.stub, { log }));
    expect(first).toEqual({ queued: 0, remaining: 2, error: "request failed (TypeError)" });

    const status = queueStub(() => new Response("not json a@example.test", { status: 503 }));
    const second = await launchSend(options(status.stub, { log }));
    expect(second).toEqual({ queued: 0, remaining: 2, error: "HTTP 503" });
    // Neither the thrown error's text nor the reply's body reaches the output.
    for (const line of lines) expect(line).not.toMatch(/@|example\.test/);
    for (const email of [confirmed(0), confirmed(1)]) {
      expect((await rowOf(email)).notified_at).toBeNull();
    }
  });

  it("The launch send emails each confirmed address once: two runs at once queue each address once", async () => {
    await seed(40);
    const a = queueStub();
    const b = queueStub();

    const [first, second] = await Promise.all([
      launchSend(options(a.stub, { batchSize: 3 })),
      launchSend(options(b.stub, { batchSize: 3 })),
    ]);

    const queued = [...a.pushed, ...b.pushed].flatMap((p) => p.messages.map((m) => m.body.to));
    expect(queued).toHaveLength(40);
    expect(new Set(queued).size).toBe(40);
    expect(first.queued + second.queued).toBe(40);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
  });

  it("The launch send emails each confirmed address once: running it again queues nothing", async () => {
    await seed(3);
    await launchSend(options(queueStub().stub));
    const again = queueStub();

    const result = await launchSend(options(again.stub));

    expect(result).toEqual({ queued: 0, remaining: 0, error: null });
    expect(again.pushed).toEqual([]);
  });

  it("The launch send emails each confirmed address once: a stop signal clears the batch in flight and ends the run", async () => {
    await seed(4);
    const stop = new AbortController();
    // The signal arrives while the first push is on the wire; the stub then honours it as fetch would.
    const stub: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const fail = () => reject(new DOMException("x", "AbortError"));
        init?.signal?.addEventListener("abort", fail);
        stop.abort();
        if (init?.signal?.aborted) fail();
      });

    const result = await launchSend(options(stub, { batchSize: 2, signal: stop.signal }));

    expect(result.queued).toBe(0);
    expect(result.remaining).toBe(4);
    expect(result.error).toBe("request failed (AbortError)");
    const rows = await t.db.selectFrom("waitlist").select("notified_at").execute();
    expect(rows.every((r) => r.notified_at === null)).toBe(true);
  });

  it("The launch send emails each confirmed address once: a stop signal between batches keeps what was queued", async () => {
    await seed(4);
    const stop = new AbortController();
    const first = queueStub(() => {
      stop.abort();
      return ok();
    });

    const result = await launchSend(options(first.stub, { batchSize: 2, signal: stop.signal }));

    expect(result).toEqual({ queued: 2, remaining: 2, error: null });
    expect(first.pushed).toHaveLength(1);
    const queuedTo = first.pushed.flatMap((p) => p.messages.map((m) => m.body.to));
    for (const to of queuedTo) expect((await rowOf(to)).notified_at).not.toBeNull();
    const rest = queueStub();
    await launchSend(options(rest.stub, { batchSize: 2 }));
    const again = rest.pushed.flatMap((p) => p.messages.map((m) => m.body.to));
    expect(again.filter((to) => queuedTo.includes(to))).toEqual([]);
    expect(again).toHaveLength(2);
  });

  it("The launch send emails each confirmed address once: a batch size outside 1 to 100 is clamped", async () => {
    await seed(3);
    const small = queueStub();
    await launchSend(options(small.stub, { batchSize: 0 }));
    expect(small.pushed.map((p) => p.messages.length)).toEqual([1, 1, 1]);
    await t.db.deleteFrom("waitlist").execute();
    await seed(101);
    const large = queueStub();
    await launchSend(options(large.stub, { batchSize: 1000 }));
    expect(large.pushed.map((p) => p.messages.length)).toEqual([100, 1]);
  });

  it("Secrets only from the environment: a malformed connection string is refused without quoting it", async () => {
    const bad = "postgres://user:not-a-password@host:notaport/db";
    const result = await launchSend({ ...options(queueStub().stub), connectionString: bad });
    expect(result).toEqual({
      queued: 0,
      remaining: null,
      error: "DATABASE_URL is not a valid connection string",
    });
  });

  it("The launch send script resumes where it stopped", async () => {
    // More confirmed addresses than one batch, and a run that stopped partway: the second
    // batch's push fails.
    await seed(5);
    const stopped = queueStub((call) => (call === 1 ? new Response("", { status: 500 }) : ok()));
    const firstLines: string[] = [];
    const first = await launchSend(
      options(stopped.stub, { batchSize: 2, log: (l: string) => firstLines.push(l) }),
    );
    expect(first.error).not.toBeNull();
    expect(first.remaining).toBe(3);
    const already = stopped.pushed[0]!.messages.map((m) => m.body.to);

    // Run again: only the addresses with notified_at empty are queued, and the count of those
    // still waiting is reported, 0 at the end.
    const resumed = queueStub();
    const lines: string[] = [];
    const second = await launchSend(
      options(resumed.stub, { batchSize: 2, log: (l: string) => lines.push(l) }),
    );
    const queued = resumed.pushed.flatMap((p) => p.messages.map((m) => m.body.to));
    expect([...queued].sort()).toEqual([2, 3, 4].map(confirmed));
    expect(queued.filter((to) => already.includes(to))).toEqual([]);
    expect(second).toEqual({ queued: 3, remaining: 0, error: null });
    expect(firstLines.at(-1)).toBe("3 confirmed addresses still waiting");
    expect(lines.at(-1)).toBe("0 confirmed addresses still waiting");
  });
});
