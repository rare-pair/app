import { createDb } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { inspect } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "../../mailer/src/message";
import app from "../src/index";
import {
  BASE,
  deliveredEmails,
  emailsTo,
  fetchW,
  freshIp,
  nonceOf,
  LOGIN_TOKEN,
  WAITLIST_TOKEN,
  postLogin,
  TURNSTILE,
  withoutNonce,
} from "./helpers";

// Runs in the "prelaunch" project: wrangler.jsonc as it deploys, PRELAUNCH on. Joining
// the wait list is wanted only before launch.

// The Postgres the Worker uses, through the same Hyperdrive binding. One database
// serves every test file of a project, so each test uses its own addresses.
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

const HSTS = "max-age=31536000; includeSubDomains";

/**
 * Submits the wait list form from a fresh IP, so only a test that sets `cf-connecting-ip`
 * itself meets the per-IP limit; `headers` are added over a browser's.
 */
const postWaitlist = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetchW("/waitlist", {
    method: "POST",
    headers: { ...FORM_HEADERS, "cf-connecting-ip": freshIp(), ...headers },
    body: new URLSearchParams(fields).toString(),
  });

/** Joins with a passing Turnstile token. */
const join = (email: string, headers: Record<string, string> = {}) =>
  postWaitlist({ email, "cf-turnstile-response": WAITLIST_TOKEN }, headers);

const rowOf = (email: string) =>
  db.selectFrom("waitlist").selectAll().where("email", "=", email).executeTakeFirst();

/** Lowercase hex SHA-256 of a string. */
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

let sentinels = 0;

/**
 * How many messages were queued for each address, in order. The queue delivers in
 * order, one message a batch, so once a later request's email has arrived, an earlier
 * one's would have.
 */
async function queuedForEach(addresses: string[]): Promise<number[]> {
  const sentinel = `waitlist-sentinel-${++sentinels}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const res = await postLogin({ email: sentinel, "cf-turnstile-response": LOGIN_TOKEN });
  expect(res.status).toBe(200);
  await emailsTo(sentinel);
  const bodies = (await deliveredEmails()).map((body) => JSON.stringify(body));
  // Any body addressed to it, even one the mailer would refuse.
  return addresses.map((to) => {
    const field = `"to":${JSON.stringify(to)}`;
    return bodies.filter((body) => body.includes(field)).length;
  });
}

/** How many messages were queued for `to`. */
const queuedFor = async (to: string) => (await queuedForEach([to]))[0];

/** Moves an address's last email time back 61 minutes, past the one-hour rule. */
const anHourPasses = (email: string) =>
  db
    .updateTable("waitlist")
    .set({ confirm_sent_at: sql<Date>`confirm_sent_at - interval '61 minutes'` })
    .where("email", "=", email)
    .execute();

describe("22-waitlist", () => {
  it("Joining queues one confirmation email", async () => {
    const email = fresh("joining");
    const typed = `  ${email.replace("joining", "Joining.Mixed").toUpperCase()} `;
    const stored = typed.trim().toLowerCase();

    const before = Date.now();
    const res = await join(typed);
    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    // Joining sets no cookie.
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<h1>Check your email to confirm</h1>");
    expect(html).toMatch(/7 days/);
    // The page doesn't echo the address.
    expect(html.toLowerCase()).not.toContain(stored);

    // A row for the address, trimmed and lowercased, not yet confirmed.
    const row = await rowOf(stored);
    expect(row).toBeDefined();
    expect(row!.confirmed_at).toBeNull();
    expect(row!.confirm_count).toBe(1);
    expect(Math.abs(row!.confirm_sent_at.getTime() - before)).toBeLessThan(60_000);

    // One email, linking to /waitlist/confirm with a token.
    const emails = await emailsTo(stored);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.kind).toBe("waitlist-confirm");
    const link = new URL(emails[0]!.url);
    expect(link.origin + link.pathname).toBe("https://rarepair.fans/waitlist/confirm");
    const token = link.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThanOrEqual(43);

    // Only a hash of the token is stored, never the token.
    expect(row!.confirm_token_hash).toBe(await sha256(token));
    for (const value of Object.values(row!)) expect(String(value)).not.toContain(token);
    expect(await queuedFor(stored)).toBe(1);
  });

  it("Joining twice tells nobody anything", async () => {
    const email = fresh("twice");
    // This joins one address more often than its limit allows in a minute, to test the
    // resend rules: so its joins run with that limit open. The limit has its own tests.
    const unlimited: RateLimit = { limit: async () => ({ success: true }) };
    const join = async (typed: string) =>
      (
        await runLogged(joinRequest({ email: typed, "cf-turnstile-response": WAITLIST_TOKEN }), {
          WAITLIST_EMAIL_LIMIT: unlimited,
        })
      ).res;

    const first = await join(email);
    const page = { status: first.status, body: await first.text() };
    expect(page.status).toBe(200);
    expect(await emailsTo(email)).toHaveLength(1);
    const firstHash = (await rowOf(email))!.confirm_token_hash;

    // Again within the hour: the same page, no email, the token unchanged.
    const again = await join(email);
    expect({ status: again.status, body: await again.text() }).toEqual(page);
    expect(await queuedFor(email)).toBe(1);
    expect((await rowOf(email))!.confirm_token_hash).toBe(firstHash);

    // After an hour: a fresh email, whose token replaces the old one.
    await anHourPasses(email);
    const second = await join(email);
    expect({ status: second.status, body: await second.text() }).toEqual(page);
    const twoEmails = await emailsTo(email, { atLeast: 2 });
    const secondToken = new URL(twoEmails[1]!.url).searchParams.get("token") ?? "";
    const afterSecond = (await rowOf(email))!;
    expect(afterSecond.confirm_token_hash).not.toBe(firstHash);
    expect(afterSecond.confirm_token_hash).toBe(await sha256(secondToken));

    // A third after another hour, then no more, whatever is submitted.
    await anHourPasses(email);
    await join(email);
    await emailsTo(email, { atLeast: 3 });
    const thirdHash = (await rowOf(email))!.confirm_token_hash;
    await anHourPasses(email);
    for (const typed of [email, ` ${email.toUpperCase()} `]) {
      const more = await join(typed);
      expect({ status: more.status, body: await more.text() }).toEqual(page);
    }
    expect(await queuedFor(email)).toBe(3);
    expect((await rowOf(email))!.confirm_token_hash).toBe(thirdHash);

    // A confirmed address gets the same page and no email, however long it's been.
    const confirmed = fresh("confirmed");
    await db
      .insertInto("waitlist")
      .values({
        email: confirmed,
        confirm_token_hash: null,
        confirm_sent_at: new Date(Date.now() - 3 * 24 * 3600_000),
        confirmed_at: new Date(),
      })
      .execute();
    const repeat = await join(confirmed);
    expect({ status: repeat.status, body: await repeat.text() }).toEqual(page);
    expect(await queuedFor(confirmed)).toBe(0);
  });

  it("Two joins for the same address at once", async () => {
    const email = fresh("at-once");

    const [a, b] = await Promise.all([join(email), join(email)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
    const rows = await db
      .selectFrom("waitlist")
      .select("email")
      .where("email", "=", email)
      .execute();
    expect(rows).toHaveLength(1);
    expect(await queuedFor(email)).toBe(1);
  });

  it("Join request without Turnstile is refused", async () => {
    const refusals: [string, Record<string, string>, number][] = [
      ["missing", {}, 400],
      ["failing", { "cf-turnstile-response": "not-a-token" }, 400],
      // As POST /login: siteverify not answering is a 503, with the form again.
      ["unavailable", { "cf-turnstile-response": "siteverify-down" }, 503],
    ];
    const nonces = new Set<string>();
    const addresses: string[] = [];
    for (const [name, fields, status] of refusals) {
      const email = fresh(`no-turnstile-${name}`);
      addresses.push(email);
      const res = await postWaitlist({ email, ...fields });
      expect(res.status, name).toBe(status);
      const html = await res.text();
      expectFormAgain(res, html);
      nonces.add(nonceOf(res.headers.get("content-security-policy")) ?? "");
      // What was typed comes back.
      expect(html).toContain(`value="${email}"`);
      expect(await rowOf(email)).toBeUndefined();
    }
    expect(await queuedForEach(addresses)).toEqual([0, 0, 0]);
    // A fresh nonce on each form.
    expect(nonces.size).toBe(3);

    // An address too long to be one isn't shown back.
    const long = `${"a".repeat(300)}@example.test`;
    const res = await postWaitlist({ email: long });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("a".repeat(300));
  });

  it("A join request over 16 KB is refused unread, with the form again", async () => {
    const email = fresh("too-large");
    const res = await postWaitlist({
      email,
      "cf-turnstile-response": WAITLIST_TOKEN,
      padding: "x".repeat(16 * 1024),
    });
    expect(res.status).toBe(413);
    const html = await res.text();
    expectFormAgain(res, html);
    // Nothing of it is shown back.
    expect(html).not.toContain(email);
    expect(await rowOf(email)).toBeUndefined();
  });

  it("Join request without a valid address is refused", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const local = `bad-${marker}`;
    const refused = [
      "",
      "   ",
      `${local}${"a".repeat(240)}@example.test`,
      `${local}.example.test`,
      `${local}@example.test@example.test`,
      `Reader <${local}@example.test>`,
      `${local}@example.test, other-${marker}@example.test`,
      `${local}@example.test,other-${marker}@example.test`,
      `${local} x@example.test`,
      `${local}\t@example.test`,
      // Control characters, which Postgres or a mail header would choke on.
      `${local}\u0000x@example.test`,
      `${local}\u001bx@example.test`,
      ...'<>()",;:\\[]'.split("").map((ch) => `${local}${ch}x@example.test`),
    ];
    for (const email of refused) {
      const res = await postWaitlist({ email, "cf-turnstile-response": WAITLIST_TOKEN });
      expect(res.status, JSON.stringify(email)).toBe(400);
      const html = await res.text();
      expectFormAgain(res, html);
      expect(html).toContain("Enter a valid email address.");
    }
    // At the length limit: 254 characters join, 255 don't. Its own marker: one is emailed.
    const edge = crypto.randomUUID().slice(0, 8);
    const at = (length: number) => {
      const domain = `@${edge}.test`;
      return `${"a".repeat(length - domain.length)}${domain}`;
    };
    const longest = await postWaitlist({ email: at(254), "cf-turnstile-response": WAITLIST_TOKEN });
    expect(longest.status).toBe(200);
    expect(await rowOf(at(254))).toBeDefined();
    const tooLong = await postWaitlist({ email: at(255), "cf-turnstile-response": WAITLIST_TOKEN });
    expect(tooLong.status).toBe(400);
    expect(await rowOf(at(255))).toBeUndefined();

    // No field is missing a check: with no address at all, it's refused the same way.
    const none = await postWaitlist({ "cf-turnstile-response": WAITLIST_TOKEN });
    expect(none.status).toBe(400);

    const rows = await db
      .selectFrom("waitlist")
      .select("email")
      .where("email", "like", `%${marker}%`)
      .execute();
    expect(rows).toEqual([]);
    const sentinel = await queuedFor(`unused-${marker}@example.test`);
    expect(sentinel).toBe(0);
    const anyMarked = (await deliveredEmails()).filter((b) => JSON.stringify(b).includes(marker));
    expect(anyMarked).toEqual([]);
  });

  it("Cross-site join request is refused", async () => {
    const refused: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "https://rarepair.fans.evil.example" },
      { origin: "http://rarepair.fans" },
      { origin: "https://content.rarepair.fans" },
      { origin: "null" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
    ];
    const addresses: string[] = [];
    for (const headers of refused) {
      const email = fresh("cross-site");
      addresses.push(email);
      const res = await join(email, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get("strict-transport-security")).toBe(HSTS);
      const html = await res.text();
      // Wait list wording, back to the form, not to sign-in.
      expect(html).toContain('<a href="/">');
      expect(html).not.toContain('href="/login"');
      expect(await rowOf(email)).toBeUndefined();
    }
    expect(await queuedForEach(addresses)).toEqual(refused.map(() => 0));

    // Neither header, as no browser sends a form: refused as POST /login refuses it.
    const email = fresh("no-headers");
    const res = await fetchW("/waitlist", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, "cf-turnstile-response": WAITLIST_TOKEN }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await rowOf(email)).toBeUndefined();
  });
});

/** The same app, run on `bindings` over the test env, with every console line captured. */
async function runLogged(request: Request, bindings: Partial<Cloudflare.Env> = {}) {
  // Every console line, as a log would show it: inspect prints an error's stack,
  // cause and own fields, at any depth.
  const logged: string[] = [];
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args) => {
      logged.push(args.map((arg) => inspect(arg, { depth: Infinity })).join(" "));
    }),
  );
  try {
    const ctx = createExecutionContext();
    const res = await app.fetch(request, { ...env, ...bindings }, ctx);
    await waitOnExecutionContext(ctx);
    return { res, logged };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** The wait list form's POST, as a browser on rarepair.fans submits it. */
const joinRequest = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/waitlist`, {
    method: "POST",
    headers: { ...FORM_HEADERS, "cf-connecting-ip": freshIp(), ...headers },
    body: new URLSearchParams(fields).toString(),
  });

/** A queue that refuses every email with an error naming its address and link. */
function refusingQueue() {
  const sent = { count: 0 };
  const queue: Queue<EmailMessage> = {
    send: async (message) => {
      sent.count += 1;
      throw new Error(`queue refused the email to ${message.to} with ${message.url}`);
    },
    sendBatch: async () => {
      throw new Error("queue refused the batch");
    },
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  return { queue, sent };
}

describe("22-waitlist privacy", () => {
  it("The wait list keeps only what the launch email needs", async () => {
    const email = fresh("private");
    const ip = "203.0.113.77";
    const agent = "PrivacyTestAgent/9.9";
    const referer = "https://referrer.example/private-page";
    const request = {
      "cf-connecting-ip": ip,
      "user-agent": agent,
      referer,
    };

    // A join, a refused join and a resend, each logged nowhere by address.
    const joined = await runLogged(
      joinRequest({ email, "cf-turnstile-response": WAITLIST_TOKEN }, request),
    );
    expect(joined.res.status).toBe(200);
    const refused = await runLogged(joinRequest({ email, "cf-turnstile-response": "x" }, request));
    expect(refused.res.status).toBe(400);
    await anHourPasses(email);
    const resent = await runLogged(
      joinRequest({ email, "cf-turnstile-response": WAITLIST_TOKEN }, request),
    );
    expect(resent.res.status).toBe(200);
    const emails = await emailsTo(email, { atLeast: 2 });
    const tokens = emails.map((e) => new URL(e.url).searchParams.get("token") ?? "");

    // Only the address, the token hashes and their times, confirmed_at and notified_at.
    const row = (await rowOf(email))!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "confirm_count",
        "confirm_sent_at",
        "confirm_token_hash",
        "confirmed_at",
        "created_at",
        "email",
        "notified_at",
        "unsubscribe_token_hash",
      ].sort(),
    );
    const values = Object.values(row).map(String).join("\n");
    for (const sent of [ip, agent, referer, "referrer.example", ...tokens]) {
      expect(values).not.toContain(sent);
    }

    // No log line holds the address or a link.
    for (const { logged } of [joined, refused, resent]) {
      const text = logged.join("\n");
      expect(text).not.toContain(email);
      expect(text).not.toMatch(/https?:\/\//);
    }
  });

  it("A join whose email can't be queued keeps nothing, and logs no address", async () => {
    const email = fresh("unqueued");
    const { queue, sent } = refusingQueue();

    const { res, logged } = await runLogged(
      joinRequest({ email, "cf-turnstile-response": WAITLIST_TOKEN }),
      { EMAIL: queue },
    );

    // It failed where the error names the address and the link.
    expect(sent.count).toBe(1);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).not.toContain("<form");
    expect(html).not.toContain(email);
    expect(await rowOf(email)).toBeUndefined();
    expect(logged.length).toBeGreaterThan(0);
    const text = logged.join("\n");
    expect(text).not.toContain(email);
    expect(text).not.toMatch(/https?:\/\//);

    // So joining again works at once, without waiting out the hour.
    expect((await join(email)).status).toBe(200);
    await emailsTo(email);
    expect(await queuedFor(email)).toBe(1);
  });

  it("A resend whose email can't be queued leaves the row as it was", async () => {
    const email = fresh("unqueued-resend");
    expect((await join(email)).status).toBe(200);
    await emailsTo(email);
    await anHourPasses(email);
    // The time as Postgres keeps it, to the microsecond: a Date would round it.
    const exactly = () =>
      db
        .selectFrom("waitlist")
        .select((eb) => [
          "confirm_token_hash",
          "confirm_count",
          eb.cast<string>("confirm_sent_at", "text").as("confirm_sent_at"),
        ])
        .where("email", "=", email)
        .executeTakeFirst();
    const before = await exactly();
    const { queue, sent } = refusingQueue();

    const { res } = await runLogged(
      joinRequest({ email, "cf-turnstile-response": WAITLIST_TOKEN }),
      { EMAIL: queue },
    );

    expect(sent.count).toBe(1);
    expect(res.status).toBe(503);
    expect(await exactly()).toEqual(before);
  });
});

/**
 * The coming-soon form shown again with an error: its widget, its scripts under the
 * response's nonce, its noscript message, and the Turnstile frame allowed (#181).
 */
function expectFormAgain(res: Response, html: string) {
  expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  // It may hold what was typed, so no cache keeps it.
  expect(res.headers.get("cache-control")).toBe("no-store");
  const csp = res.headers.get("content-security-policy");
  expect(withoutNonce(csp)).toBe(TURNSTILE);
  const nonce = nonceOf(csp);
  expect(html).toContain('<p role="alert">');
  expect(html).toMatch(/<form class="waitlist" method="post" action="\/waitlist">/);
  expect(html).toContain(`<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}"`);
  expect(html).toMatch(/<noscript><p>[^<]*joining the wait list needs JavaScript/i);
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts).toHaveLength(2);
  for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
}
