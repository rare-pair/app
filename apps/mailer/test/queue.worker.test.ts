import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

const RESEND_BATCH = "https://api.resend.com/emails/batch";

const signIn = (n: number) => ({
  kind: "sign-in",
  to: `reader${n}@example.test`,
  url: `https://rarepair.fans/login/confirm?token=link-${n}`,
});

function batchOf(bodies: unknown[]) {
  return createMessageBatch(
    "email",
    bodies.map((body, i) => ({ id: `msg-${i}`, timestamp: new Date(1000), attempts: 1, body })),
  );
}

async function consume(bodies: unknown[]) {
  const batch = batchOf(bodies);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("01-auth-magic-link", () => {
  it("Sign-in emails go through Resend in batches", async () => {
    const calls = stubResend(accepted);

    const result = await consume([signIn(1), signIn(2), signIn(3)]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_BATCH);
    expect(calls[0]!.emails).toHaveLength(3);
    expect(result.explicitAcks.sort()).toEqual(["msg-0", "msg-1", "msg-2"]);
    expect(result.retryMessages).toEqual([]);
  });
});

const waitlistConfirm = (n: number) => ({
  kind: "waitlist-confirm",
  to: `joiner${n}@example.test`,
  url: `https://rarepair.fans/waitlist/confirm?token=join-${n}`,
});

describe("22-waitlist", () => {
  it("A wait list confirmation email goes through Resend with its link", async () => {
    const calls = stubResend(accepted);

    const result = await consume([waitlistConfirm(1)]);

    expect(calls).toHaveLength(1);
    // SAFETY: each email the mailer renders carries these fields.
    const [sent] = calls[0]!.emails as { to: string; subject: string; text: string }[];
    expect(sent!.to).toBe("joiner1@example.test");
    expect(sent!.subject).toBe("Confirm your place on the rarepair wait list");
    expect(sent!.text).toContain("https://rarepair.fans/waitlist/confirm?token=join-1");
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("A wait list email linking anywhere but /waitlist/confirm is not sent", async () => {
    const calls = stubResend(accepted);
    const link = (url: string) => ({ ...waitlistConfirm(2), url });

    const result = await consume([
      waitlistConfirm(1),
      link("https://rarepair.fans/login/confirm?token=x"),
      { ...signIn(3), url: "https://rarepair.fans/waitlist/confirm?token=x" },
      link("https://evil.example/waitlist/confirm?token=x"),
      link("https://www.rarepair.fans/waitlist/confirm?token=x"),
      link("http://rarepair.fans/waitlist/confirm?token=x"),
      link("https://evil.example@rarepair.fans/waitlist/confirm?token=x"),
      link("https://rarepair.fans/waitlist/confirm?token=x#more"),
      link("https://rarepair.fans/waitlist/confirm/x?token=x"),
      link("https://rarepair.fans/waitlist/confirmx?token=x"),
      link("https://rarepair.fans/waitlist/confirm"),
    ]);

    expect(calls).toHaveLength(1);
    // SAFETY: each email the mailer renders carries these fields.
    const sent = calls[0]!.emails as { to: string; text: string }[];
    expect(sent).toHaveLength(1);
    // The one sent is the valid one.
    expect(sent[0]!.to).toBe("joiner1@example.test");
    expect(sent[0]!.text).toContain("token=join-1");
    expect(result.explicitAcks).toHaveLength(11);
    expect(result.retryMessages).toEqual([]);
  });
});

// Everything the Worker wrote to the console during one queue run, as text.
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

describe("mailer logs", () => {
  it("logs the provider, outcome and provider message IDs of each send", async () => {
    stubResend(accepted);
    const logs = captureLogs();

    await consume([signIn(1), signIn(2)]);

    const text = logs.join("\n");
    expect(text).toContain("resend");
    expect(text).toContain("sent");
    expect(text).toContain("resend-0");
    expect(text).toContain("resend-1");
  });

  it.each([
    ["sent", () => accepted],
    ["refused", () => () => new Response('{"message":"reader1@example.test"}', { status: 429 })],
    ["failed", () => () => new Response('{"message":"reader1@example.test"}', { status: 422 })],
  ] as const)("never logs an address or a link when the batch is %s", async (_, respond) => {
    stubResend(respond());
    const logs = captureLogs();

    await consume([
      signIn(1),
      { kind: "sign-in", to: "reader9@example.test", url: "http://x.test/" },
    ]);

    const text = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("link-1");
  });

  it("never logs an address or a link for a wait list email, sent or refused", async () => {
    stubResend(accepted);
    const logs = captureLogs();

    await consume([
      waitlistConfirm(1),
      { ...waitlistConfirm(2), url: "https://rarepair.fans/login/confirm?token=join-2" },
    ]);

    const text = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/join-\d/);
  });

  it("never logs an address or a link when the provider cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError(
        "could not reach reader1@example.test for https://rarepair.fans/login/confirm?token=link-1",
      ),
    );
    const logs = captureLogs();

    await consume([signIn(1)]);

    const text = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/https?:\/\//);
  });
});

// Resend's permissive batch answer: the accepted emails in `data`, the refused ones in `errors`
// by their index in the request. The shape is from resend-node's batch types.
const withRefused = (refused: number[]) => (emails: unknown[]) =>
  Response.json(
    {
      data: emails.flatMap((_, i) => (refused.includes(i) ? [] : [{ id: `resend-${i}` }])),
      errors: refused.map((index) => ({ index, message: "invalid to reader2@example.test" })),
    },
    { status: 202 },
  );

describe("one refused address", () => {
  it("One refused address does not stop the others in its batch", async () => {
    const calls = stubResend(withRefused([1]));
    const logs = captureLogs();

    const result = await consume([signIn(1), signIn(2), signIn(3)]);

    expect(calls).toHaveLength(1);
    expect(result.explicitAcks.sort()).toEqual(["msg-0", "msg-1", "msg-2"]);
    expect(result.retryMessages).toEqual([]);
    const text = logs.join("\n");
    expect(text).toContain("email.refused");
    expect(text).toContain("resend-0");
    expect(text).not.toContain("resend-1");
  });

  it("The refused email is acked with an outcome-only log line, no address, link or error text", async () => {
    stubResend(withRefused([0, 2]));
    const logs = captureLogs();

    await consume([signIn(1), signIn(2), signIn(3)]);

    const refused = logs.filter((l) => l.includes("email.refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('"count":2');
    const text = logs.join("\n");
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("invalid to");
    expect(text).not.toContain("link-");
  });
});

describe("test setup", () => {
  it("a fetch no test stubbed never reaches Resend", async () => {
    const res = await fetch(RESEND_BATCH, { method: "POST", body: "[]" });
    expect(res.status).toBe(599);
    await res.body?.cancel();
  });
});

describe("mailer failures", () => {
  it("a batch every provider refuses is retried by the queue, not acked", async () => {
    stubResend(() => new Response("{}", { status: 503 }));

    const result = await consume([signIn(1), signIn(2)]);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["msg-0", "msg-1"]);
    expect(result.retryBatch.retry).toBe(false);
    expect(result.ackAll).toBe(false);
  });

  it("a message that breaks the contract is not sent and does not hold up the batch", async () => {
    const calls = stubResend(accepted);

    const result = await consume([
      signIn(1),
      { kind: "sign-in", to: "reader2@example.test" },
      { kind: "newsletter", to: "reader3@example.test", url: "https://rarepair.fans/" },
      { kind: "sign-in", to: "reader4@example.test", url: "javascript:alert(1)" },
      "not an object",
      {
        kind: "sign-in",
        to: "reader5@example.test",
        url: "https://evil.example/login/confirm?token=x",
      },
      { kind: "sign-in", to: "reader6@example.test", url: "https://rarepair.fans/upload" },
      {
        kind: "sign-in",
        to: "reader7@example.test",
        url: "https://evil.example@rarepair.fans/login/confirm?token=x",
      },
      { kind: "sign-in", to: "Support<reader8@example.test>", url: signIn(8).url },
      { kind: "sign-in", to: "reader9@example.test,other@example.test", url: signIn(9).url },
      { kind: "sign-in", to: `${"a".repeat(250)}@example.test`, url: signIn(10).url },
      { kind: "sign-in", to: "reader11@example.test", url: `${signIn(11).url}${"x".repeat(2048)}` },
      { kind: "sign-in", to: "reader12@example.test", url: `${signIn(12).url}#more` },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.emails).toHaveLength(1);
    expect(result.explicitAcks).toHaveLength(13);
    expect(result.explicitAcks).toContain("msg-0");
    expect(result.retryMessages).toEqual([]);
  });

  it("a link with line breaks in it cannot add lines to the email", async () => {
    const calls = stubResend(accepted);

    await consume([
      {
        kind: "sign-in",
        to: "reader1@example.test",
        url: "https://rarepair.fans/login/confirm?token=x\n\nInjected line\n",
      },
    ]);

    // SAFETY: each email the mailer renders carries a text body.
    const [sent] = calls[0]!.emails as { text: string }[];
    expect(sent!.text).not.toContain("\nInjected line");
    expect(sent!.text).toContain("https://rarepair.fans/login/confirm?token=xInjected%20line");
  });
});

describe("16-removal-and-opt-out", () => {
  it("A removal confirmation email goes through Resend with its link", async () => {
    const calls = stubResend(accepted);
    const link = "https://rarepair.fans/remove/confirm?token=req-1";

    const result = await consume([
      { kind: "removal-confirm", to: "requester1@example.test", url: link },
      // The wrong page for the kind is never sent.
      {
        kind: "removal-confirm",
        to: "requester2@example.test",
        url: "https://rarepair.fans/login/confirm?token=req-2",
      },
    ]);

    expect(calls).toHaveLength(1);
    // SAFETY: each email the mailer renders carries these fields.
    const sent = calls[0]!.emails as { to: string; text: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("requester1@example.test");
    expect(sent[0]!.text).toContain(link);
    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toEqual([]);
  });
});
