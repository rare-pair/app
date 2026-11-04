import { createDb } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { WAITLIST_WINDOW_SECONDS } from "../src/rate-limit";
import {
  BASE,
  consoleDuring,
  deliveredEmails,
  emailsTo,
  fetchW,
  freshIp,
  LOGIN_TOKEN,
  WAITLIST_TOKEN,
  postLogin,
  windowHeadroom,
} from "./helpers";
import { WAITLIST_EMAIL_LIMIT, WAITLIST_IP_LIMIT } from "./limits";

// Runs in the "prelaunch" project: wrangler.jsonc as it deploys, PRELAUNCH on.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** An address no other test uses, in lowercase. */
const fresh = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

/** The headers a browser on rarepair.fans sends with the wait list form. */
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: BASE,
  "sec-fetch-site": "same-origin",
};

/** The wait list form's POST from `ip`, which is new unless a test gives one. */
const joinRequest = (fields: Record<string, string>, ip = freshIp()) =>
  new Request(`${BASE}/waitlist`, {
    method: "POST",
    headers: { ...FORM_HEADERS, "cf-connecting-ip": ip },
    body: new URLSearchParams(fields).toString(),
  });

/** Joins through the Worker with a passing Turnstile token, from `ip`. */
const join = (email: string, ip = freshIp(), token = WAITLIST_TOKEN) =>
  fetchW("/waitlist", {
    method: "POST",
    headers: { ...FORM_HEADERS, "cf-connecting-ip": ip },
    body: new URLSearchParams({ email, "cf-turnstile-response": token }).toString(),
  });

const rowOf = (email: string) =>
  db.selectFrom("waitlist").selectAll().where("email", "=", email).executeTakeFirst();

/**
 * How many messages were queued for `to`. The queue delivers in order, one message a batch,
 * so once a later sign-in's email has arrived, an earlier one's would have.
 */
async function queuedFor(to: string) {
  const sentinel = `ratelimit-sentinel-${crypto.randomUUID().slice(0, 8)}@example.test`;
  expect((await postLogin({ email: sentinel, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(
    200,
  );
  await emailsTo(sentinel);
  const field = `"to":${JSON.stringify(to)}`;
  return (await deliveredEmails()).filter((body) => JSON.stringify(body).includes(field)).length;
}

/**
 * Spends one IP's wait list limit for the current window on requests Turnstile refuses: the IP
 * is counted before the form is read, so they count all the same.
 */
async function fillIpLimit(ip: string) {
  for (let i = 0; i < WAITLIST_IP_LIMIT; i++) {
    const res = await join(`filler-${i}@example.test`, ip, "a-failing-token");
    expect(res.status).toBe(400);
  }
}

/** The shared 429: `Retry-After` and a plain page, both saying the window. */
async function expectTooManyRequests(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe(String(WAITLIST_WINDOW_SECONDS));
  const html = await res.text();
  expect(html).toContain("<h1>Too many requests</h1>");
  expect(html).toContain(`Please try again in ${WAITLIST_WINDOW_SECONDS} seconds.`);
}

describe("22-waitlist rate limits", () => {
  it("Join requests are rate-limited per IP", async () => {
    await windowHeadroom(WAITLIST_WINDOW_SECONDS);
    const ip = freshIp();
    await fillIpLimit(ip);

    // Even for a different address, and one that would have joined.
    const email = fresh("per-ip");
    await expectTooManyRequests(await join(email, ip));
    expect(await rowOf(email)).toBeUndefined();
    expect(await queuedFor(email)).toBe(0);

    // Another IP is not held up with it.
    expect((await join(email)).status).toBe(200);
    expect(await rowOf(email)).toBeDefined();
  });

  it("Join requests are rate-limited per email", async () => {
    await windowHeadroom(WAITLIST_WINDOW_SECONDS);
    const email = fresh("per-email");
    // The limit's worth of joins, each from another IP.
    for (let i = 0; i < WAITLIST_EMAIL_LIMIT; i++) {
      expect((await join(email)).status).toBe(200);
    }
    await emailsTo(email);
    const before = await rowOf(email);
    expect(before!.confirm_count).toBe(1);

    // From yet another IP, and spelt differently: the same address.
    await expectTooManyRequests(await join(` ${email.toUpperCase()} `));
    expect(await rowOf(email)).toEqual(before);
    // The hourly rule held back all but the first email; the refused join added none.
    expect(await queuedFor(email)).toBe(1);

    // A different address from a new IP is not held up with it.
    expect((await join(fresh("other"))).status).toBe(200);
  });

  it("Join requests Turnstile refuses don't count against the address", async () => {
    // No wait for headroom: a new window could only let the last request through.
    const email = fresh("per-email-unsolved");
    for (let i = 0; i < WAITLIST_EMAIL_LIMIT; i++) {
      expect((await join(email, freshIp(), "a-failing-token")).status).toBe(400);
    }
    expect((await join(email)).status).toBe(200);
  });

  it("A failing rate limiter lets a join through and logs no address, IP or key", async () => {
    const keys: string[] = [];
    const failing: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        throw new Error(`limiter refused ${key}`);
      },
    };
    const email = fresh("limiter-down");
    const ip = freshIp();
    let status = 0;
    const logged = await consoleDuring(async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        joinRequest({ email, "cf-turnstile-response": WAITLIST_TOKEN }, ip),
        { ...env, WAITLIST_IP_LIMIT: failing, WAITLIST_EMAIL_LIMIT: failing },
        ctx,
      );
      status = res.status;
      await waitOnExecutionContext(ctx);
    });

    // Turnstile still guards the form, so the join goes through.
    expect(status).toBe(200);
    expect(await emailsTo(email)).toHaveLength(1);
    expect(keys).toHaveLength(2);
    expect(logged.length).toBeGreaterThan(0);
    const log = logged.join("\n");
    for (const secret of [email, "limiter-down", ip, ...keys]) expect(log).not.toContain(secret);
  });
});

// Every answer takes at least the floor, so the time can't show whether an address is on the
// list (#216). A short floor stands in for the deployed one, and only lower bounds are
// asserted, so a slow machine can't fail them. Allowed a few ms under: the timer and the
// clock the test reads need not agree to the millisecond.
describe("22-waitlist response-time floor", () => {
  const FLOOR_MS = 600;
  const SLACK_MS = 20;
  const open: RateLimit = { limit: async () => ({ success: true }) };

  /** The Worker's answer to `request` with the floor at FLOOR_MS and `bindings` over the env. */
  async function timed(request: Request, bindings: Partial<Cloudflare.Env> = {}) {
    const ctx = createExecutionContext();
    const started = performance.now();
    const res = await app.fetch(
      request,
      // The address limit is open: one address is joined more often than it allows here.
      { ...env, WAITLIST_EMAIL_LIMIT: open, ...bindings, WAITLIST_FLOOR_MS: String(FLOOR_MS) },
      ctx,
    );
    const elapsed = performance.now() - started;
    await waitOnExecutionContext(ctx);
    return { res, elapsed };
  }

  const joining = (email: string) =>
    joinRequest({ email, "cf-turnstile-response": WAITLIST_TOKEN });

  it("Every join answers no sooner than the floor, whatever the outcome", async () => {
    // A new address.
    const newcomer = fresh("floor-new");
    const added = await timed(joining(newcomer));
    expect(added.res.status).toBe(200);
    expect(added.elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);

    // The same address again within the hour: no email owed.
    const listed = await timed(joining(newcomer));
    expect(listed.res.status).toBe(200);
    expect(listed.elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);

    // After the hour: a resend.
    await db
      .updateTable("waitlist")
      .set({ confirm_sent_at: sql<Date>`confirm_sent_at - interval '61 minutes'` })
      .where("email", "=", newcomer)
      .execute();
    const resent = await timed(joining(newcomer));
    expect(resent.res.status).toBe(200);
    expect(resent.elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);

    // An email that can't be queued: the 503.
    const refusing: Queue<never> = {
      send: async () => {
        throw new Error("queue refused");
      },
      sendBatch: async () => {
        throw new Error("queue refused the batch");
      },
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    };
    const refused = await timed(joining(fresh("floor-refused")), { EMAIL: refusing });
    expect(refused.res.status).toBe(503);
    expect(refused.elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
  });

  it("A join over its limit answers no sooner than the floor either", async () => {
    const limited: RateLimit = { limit: async () => ({ success: false }) };
    const { res, elapsed } = await timed(joining(fresh("floor-limited")), {
      WAITLIST_IP_LIMIT: limited,
    });
    expect(res.status).toBe(429);
    expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
  });

  it("A join that fails with an error answers no sooner than the floor", async () => {
    // A database that refuses the connection: the handler throws, and onError answers 500.
    const broken = { connectionString: "postgresql://nobody:none@127.0.0.1:1/none" };
    let result = { status: 0, elapsed: 0 };
    await consoleDuring(async () => {
      const { res, elapsed } = await timed(joining(fresh("floor-error")), {
        // SAFETY: only connectionString is read from the binding.
        HYPERDRIVE: broken as Hyperdrive,
      });
      result = { status: res.status, elapsed };
    });
    expect(result.status).toBe(500);
    expect(result.elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
  });
});
