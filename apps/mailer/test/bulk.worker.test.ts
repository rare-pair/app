import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

const RESEND_BATCH = "https://api.resend.com/emails/batch";

const launch = (n: number) => ({
  kind: "waitlist-launch",
  to: `waiter${n}@example.test`,
  url: `https://rarepair.fans/waitlist/unsubscribe?token=bye-${n}`,
});
const signIn = (n: number) => ({
  kind: "sign-in",
  to: `reader${n}@example.test`,
  url: `https://rarepair.fans/login/confirm?token=link-${n}`,
});

// No wait between bulk batches unless a test sets one.
const noPause = { ...env, BULK_INTERVAL_SECONDS: "0" };

async function consume(queue: string, bodies: unknown[], workerEnv: Cloudflare.Env = noPause) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body, i) => ({ id: `msg-${i}`, timestamp: new Date(1000), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, workerEnv, ctx);
  return getQueueResult(batch, ctx);
}

function stubResend(respond: (emails: unknown[]) => Response) {
  const calls: { url: string; emails: unknown[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    // SAFETY: the Resend sender posts its batch as a JSON string.
    const emails: unknown[] = JSON.parse(init?.body as string);
    calls.push({ url, emails });
    return respond(emails);
  });
  return calls;
}

const accepted = (emails: unknown[]) =>
  Response.json({ data: emails.map((_, i) => ({ id: `resend-${i}` })) });

function captureLogs() {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      // oxlint-disable-next-line deslop/no-runtime-typeof -- console takes any value; strings print bare
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("22-waitlist", () => {
  it("The launch email goes through Resend's batch API from email-bulk, with its unsubscribe link", async () => {
    const calls = stubResend(accepted);

    const result = await consume("email-bulk", [launch(1), launch(2)]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_BATCH);
    // SAFETY: each email the mailer renders carries these fields.
    const sent = calls[0]!.emails as { to: string; text: string }[];
    expect(sent.map((e) => e.to)).toEqual(["waiter1@example.test", "waiter2@example.test"]);
    expect(sent[0]!.text).toContain("https://rarepair.fans/waitlist/unsubscribe?token=bye-1");
    expect(result.explicitAcks.sort()).toEqual(["msg-0", "msg-1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("The launch send puts the unsubscribe headers on each email, and a sign-in email has none", async () => {
    const calls = stubResend(accepted);

    await consume("email-bulk", [launch(1), launch(2)]);
    await consume("email", [signIn(1)]);

    // SAFETY: each email the mailer renders is a JSON object.
    const bulk = calls[0]!.emails as { headers?: Record<string, string> }[];
    expect(bulk.map((e) => e.headers)).toEqual([
      {
        "List-Unsubscribe": "<https://rarepair.fans/waitlist/unsubscribe?token=bye-1>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      {
        "List-Unsubscribe": "<https://rarepair.fans/waitlist/unsubscribe?token=bye-2>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    ]);
    // SAFETY: as above.
    const single = calls[1]!.emails as { headers?: unknown }[];
    expect(single[0]).not.toHaveProperty("headers");
  });

  it("The launch send is spread out: the consumer holds each batch for the interval", async () => {
    stubResend(accepted);
    const started = Date.now();

    await consume("email-bulk", [launch(1)], { ...env, BULK_INTERVAL_SECONDS: "0.6" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  it("Sign-in emails are not delayed by the launch send", async () => {
    stubResend(accepted);
    const paced = { ...env, BULK_INTERVAL_SECONDS: "1.5" };
    let bulkDone = false;

    const bulk = consume("email-bulk", [launch(1)], paced).then((r) => {
      bulkDone = true;
      return r;
    });
    const started = Date.now();
    const result = await consume("email", [signIn(1)], paced);
    const took = Date.now() - started;

    // The sign-in email is sent and acked while the launch batch is still waiting out its interval.
    expect(bulkDone).toBe(false);
    expect(took).toBeLessThan(1000);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect((await bulk).explicitAcks).toEqual(["msg-0"]);
  });

  it("A launch email that Resend refuses is retried, never acked", async () => {
    stubResend(() => new Response("nope", { status: 500 }));

    const result = await consume("email-bulk", [launch(1), launch(2)]);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["msg-0", "msg-1"]);
  });

  it("A launch email on the email queue, and a sign-in email on email-bulk, are acked unsent", async () => {
    const calls = stubResend(accepted);
    const logs = captureLogs();

    const onEmail = await consume("email", [launch(1)]);
    const onBulk = await consume("email-bulk", [signIn(1)]);

    expect(calls).toHaveLength(0);
    expect(onEmail.explicitAcks).toEqual(["msg-0"]);
    expect(onBulk.explicitAcks).toEqual(["msg-0"]);
    expect(logs.join("\n")).toContain("email.invalid");
  });

  it("Nothing prints a launch email's address or link to logs", async () => {
    stubResend(accepted);
    const logs = captureLogs();

    await consume("email-bulk", [launch(1), { ...launch(2), url: "https://evil.example/x" }]);
    stubResend(() => new Response("refused waiter3@example.test", { status: 500 }));
    await consume("email-bulk", [launch(3)]);

    const text = logs.join("\n");
    expect(text).toContain("email.send");
    expect(text).not.toContain("example.test");
    expect(text).not.toContain("rarepair.fans");
    expect(text).not.toContain("bye-");
  });
});
