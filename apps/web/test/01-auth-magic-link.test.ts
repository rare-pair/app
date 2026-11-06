import { createDb } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../../mailer/src/message";
import app from "../src/index";
import { signInEmailHash } from "../src/ip-hash";
import { secondsToReset } from "../src/quota";
import { LOGIN_WINDOW_SECONDS } from "../src/rate-limit";
import {
  consoleDuring,
  deliveredEmails,
  emailsTo,
  fetchW,
  freshIp,
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  loginRequest,
  nonceOf,
  LOGIN_TOKEN,
  postLogin,
  signIn,
  windowHeadroom,
} from "./helpers";

/** The opening tag of the sign-in form, or null. */
const formTag = (html: string) => html.match(/<form\b[^>]*action="\/login"[^>]*>/)?.[0] ?? null;

// The Postgres the Worker uses, through the same Hyperdrive binding. One database
// serves every test file of a project, so each test uses its own email address.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const verificationIds = async () =>
  new Set((await db.selectFrom("verification").select("id").execute()).map((r) => r.id));

// 254 characters: a 64-character local part and labels of at most 63.
const LONGEST_EMAIL = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(56)}.test`;

let sentinels = 0;

/**
 * Whether anything was queued for `to`. The queue delivers in order, one message
 * a batch, so once a later request's email has arrived, an earlier one's would have.
 */
async function queuedFor(to: string): Promise<boolean> {
  const sentinel = `sentinel-${++sentinels}@example.test`;
  const res = await postLogin({ email: sentinel, "cf-turnstile-response": LOGIN_TOKEN });
  expect(res.status).toBe(200);
  expect(await emailsTo(sentinel)).toHaveLength(1);
  // Any body addressed to `to`, even one the mailer would refuse.
  const field = `"to":${JSON.stringify(to)}`;
  return (await deliveredEmails()).some((body) => JSON.stringify(body).includes(field));
}

/**
 * The token rows made since `before` for `to`. By address: other test files issue,
 * and spend, tokens at the same time.
 */
const tokensMadeFor = async (to: string, before: Set<string>) =>
  (
    await db
      .selectFrom("verification")
      .select(["id", "identifier", "value", "expires_at"])
      .where("value", "like", `%${JSON.stringify(to)}%`)
      .execute()
  ).filter((row) => !before.has(row.id));

/** Shows that a refused request left nothing behind: no token and no email. */
async function expectNothingCreated(to: string, before: Set<string>) {
  expect(await tokensMadeFor(to, before)).toEqual([]);
  expect(await queuedFor(to)).toBe(false);
}

/**
 * Spends one IP's sign-in limit for the current window, on requests Turnstile refuses: the
 * IP is counted before the form is read, so they count all the same.
 */
async function fillIpLimit(ip: string) {
  for (let i = 0; i < LOGIN_IP_LIMIT; i++) {
    const res = await postLogin(
      { email: `filler-${i}@example.test`, "cf-turnstile-response": "a-failing-token" },
      { headers: { "cf-connecting-ip": ip } },
    );
    expect(res.status).toBe(400);
  }
}

/** Shows a response is the 429 for a limited sign-in, and returns its page. */
async function expectTooManyRequests(res: Response): Promise<string> {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe(String(LOGIN_WINDOW_SECONDS));
  const html = await res.text();
  expect(html).toContain(`Please try again in ${LOGIN_WINDOW_SECONDS} seconds.`);
  return html;
}

const TODAY = sql<string>`(now() at time zone 'utc')::date`;

/** Sets how many sign-in emails `email` has used on a day, as earlier requests would have. */
async function setCountToday(email: string, count: number, day = TODAY) {
  await db
    .insertInto("sign_in_email_counts")
    .values({
      address_hash: await signInEmailHash(env.IP_HASH_KEY, email),
      day,
      count,
    })
    .execute();
}

/** How many sign-in emails `email` has used today, or null when none was counted. */
async function countToday(email: string): Promise<number | null> {
  const row = await db
    .selectFrom("sign_in_email_counts")
    .select("count")
    .where("address_hash", "=", await signInEmailHash(env.IP_HASH_KEY, email))
    .where("day", "=", TODAY)
    .executeTakeFirst();
  return row?.count ?? null;
}

describe("01-auth-magic-link", () => {
  it("Sign-in page shows an email form", async () => {
    const res = await fetchW("/login?next=%2Fworks%2F1");
    expect(res.status).toBe(200);
    const nonce = nonceOf(res.headers.get("content-security-policy"));
    const html = await res.text();

    const form = formTag(html);
    expect(form).toContain('method="post"');
    expect(html).toMatch(
      /<input\b[^>]*type="email"[^>]*name="email"[^>]*maxlength="254"[^>]*required/,
    );
    // The page it was opened from comes back after sign-in.
    expect(html).toMatch(/<input\b[^>]*type="hidden"[^>]*name="next"[^>]*value="\/works\/1"/);
    // Turnstile alongside: the widget, with the site key from wrangler.jsonc, and its script.
    expect(html).toContain(
      `<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-action="login">`,
    );
    expect(html).toContain(
      `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" nonce="${nonce}"`,
    );
  });

  it("Sign-in page without JavaScript explains it is needed", async () => {
    const res = await fetchW("/login");
    const nonce = nonceOf(res.headers.get("content-security-policy"));
    const html = await res.text();

    expect(html).toMatch(/<noscript>[^]*Signing in needs JavaScript[^]*<\/noscript>/);
    // Without JavaScript nothing can be submitted: the only form is hidden, and only a
    // script, nonced for this page, shows it.
    expect(html.match(/<form\b[^>]*>/g)).toEqual([formTag(html)]);
    expect(formTag(html)).toMatch(/\shidden[\s>]/);
    expect(html).toContain(
      `<script nonce="${nonce}">document.getElementById("sign-in").hidden = false;</script>`,
    );
  });

  it("Requesting a magic link queues an email with a single-use token", async () => {
    const before = await verificationIds();
    const res = await postLogin({
      email: "queued@example.test",
      next: "/works/1",
      "cf-turnstile-response": LOGIN_TOKEN,
    });
    expect(res.status).toBe(200);

    // One email, in the shape apps/mailer accepts, linking to /login/confirm with a token.
    const [email, ...more] = await emailsTo("queued@example.test");
    expect(more).toEqual([]);
    expect(email).toMatchObject({ kind: "sign-in", to: "queued@example.test" });
    const link = new URL(email!.url);
    expect(link.origin + link.pathname).toBe("https://rarepair.fans/login/confirm");
    const token = link.searchParams.get("token");
    expect(token).toMatch(/^\S{16,}$/);
    expect(link.searchParams.get("next")).toBe("/works/1");

    // Only a hash of it is stored, and it is valid for 15 minutes.
    const rows = await tokensMadeFor("queued@example.test", before);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).not.toContain(token);
    expect(rows[0]!.value).not.toContain(token);
    const lifetime = rows[0]!.expires_at.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);

    // Whatever host the request came in on, the link is to rarepair.fans.
    const elsewhere = await postLogin(
      {
        email: "queued-elsewhere@example.test",
        "cf-turnstile-response": `${LOGIN_TOKEN}@web.internal.example`,
      },
      { url: "https://web.internal.example/login" },
    );
    expect(elsewhere.status).toBe(200);
    const [other] = await emailsTo("queued-elsewhere@example.test");
    expect(new URL(other!.url).origin).toBe("https://rarepair.fans");
  });

  it("Check-your-email page sets expectations", async () => {
    const res = await postLogin({
      email: "expectations@example.test",
      "cf-turnstile-response": LOGIN_TOKEN,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Check your email</h1>");
    expect(html).toContain("It lasts 15 minutes.");
    expect(html).toContain("The link can take a minute to arrive during busy periods.");
  });

  it("Login request without Turnstile is refused", async () => {
    const cases: [string, Record<string, string>][] = [
      ["no-turnstile@example.test", {}],
      ["empty-turnstile@example.test", { "cf-turnstile-response": "" }],
      ["failing-turnstile@example.test", { "cf-turnstile-response": "a-failing-token" }],
      // Solved, but for another host than the one the form was posted to.
      [
        "other-host-turnstile@example.test",
        { "cf-turnstile-response": `${LOGIN_TOKEN}@evil.example` },
      ],
    ];
    for (const [email, turnstile] of cases) {
      const before = await verificationIds();
      const res = await postLogin({ email, next: "/works/1", ...turnstile });

      expect(res.status).toBe(400);
      // The form holds what was typed, so no cache keeps it.
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      // The form again, with an error, keeping what was typed and where to go back to.
      expect(formTag(html)).not.toBeNull();
      expect(html).toContain(
        '<p role="alert">The anti-spam check did not pass. Please try again.</p>',
      );
      expect(html).toContain(`value="${email}"`);
      expect(html).toMatch(/name="next" value="\/works\/1"/);
      await expectNothingCreated(email, before);
    }
  });

  it("Cross-site login request is refused", async () => {
    const cases: [string, Record<string, string>][] = [
      ["evil-origin@example.test", { origin: "https://evil.example" }],
      ["content-origin@example.test", { origin: "https://content.rarepair.fans" }],
      ["same-site@example.test", { "sec-fetch-site": "same-site" }],
      ["cross-site@example.test", { "sec-fetch-site": "cross-site" }],
    ];
    for (const [email, headers] of cases) {
      const before = await verificationIds();
      const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN }, { headers });
      expect(res.status).toBe(403);
      await expectNothingCreated(email, before);
    }

    // Neither header at all (the brief's ruling): refused too.
    const before = await verificationIds();
    const bare = await fetchW("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "no-headers@example.test",
        "cf-turnstile-response": LOGIN_TOKEN,
      }).toString(),
    });
    expect(bare.status).toBe(403);
    await expectNothingCreated("no-headers@example.test", before);
  });

  it("An oversized sign-in request is refused before it is read", async () => {
    // A form body of exactly `bytes` bytes, passing Turnstile.
    const prefix = `email=oversized%40example.test&cf-turnstile-response=${LOGIN_TOKEN}&padding=`;
    const formOf = (bytes: number) => prefix + "x".repeat(bytes - prefix.length);
    // The same, as a stream of unknown length, so no Content-Length is sent.
    const streamOf = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 1000) {
            controller.enqueue(bytes.slice(at, at + 1000));
          }
          controller.close();
        },
      });
    };

    const before = await verificationIds();
    for (const body of [formOf(16 * 1024 + 1), streamOf(formOf(16 * 1024 + 1))]) {
      const res = await postLogin({}, { body });
      expect(res.status).toBe(413);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(formTag(html)).not.toBeNull();
      expect(html).not.toContain("oversized");
      expect(html).not.toContain("x".repeat(100));
    }
    await expectNothingCreated("oversized@example.test", before);

    // 16 KB exactly is read, either way.
    for (const body of [formOf(16 * 1024), streamOf(formOf(16 * 1024))]) {
      expect((await postLogin({}, { body })).status).toBe(200);
    }
  });

  it("An address too long to send to is not shown back", async () => {
    const longEmail = `${"a".repeat(2000)}@example.test`;
    const res = await postLogin({ email: longEmail, "cf-turnstile-response": "a-failing-token" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(formTag(html)).not.toBeNull();
    expect(html).not.toContain("a".repeat(255));
  });

  it("Requesting a link while Turnstile can't be reached is refused", async () => {
    const before = await verificationIds();
    const res = await postLogin({
      email: "turnstile-down@example.test",
      "cf-turnstile-response": "siteverify-down",
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(formTag(html)).not.toBeNull();
    expect(html).toContain('<p role="alert">');
    await expectNothingCreated("turnstile-down@example.test", before);
  });

  it("Requesting a link for the longest address the mailer sends to works", async () => {
    expect(LONGEST_EMAIL).toHaveLength(254);
    const res = await postLogin({ email: LONGEST_EMAIL, "cf-turnstile-response": LOGIN_TOKEN });
    expect(res.status).toBe(200);
    expect(await emailsTo(LONGEST_EMAIL)).toHaveLength(1);
  });

  it("Requesting a link for an invalid address shows the form again", async () => {
    // Also none at all, and a well-formed one a character longer than the mailer sends to.
    for (const email of ["not-an-address", "", `a${LONGEST_EMAIL}`]) {
      const before = await verificationIds();
      const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(formTag(html)).not.toBeNull();
      expect(html).toContain('<p role="alert">Enter a valid email address.</p>');
      await expectNothingCreated(email, before);
    }
  });

  it("Login requests are rate-limited per IP", async () => {
    await windowHeadroom(LOGIN_WINDOW_SECONDS);
    const ip = freshIp();
    await fillIpLimit(ip);

    // Even for an address it hasn't asked for, with a passing check.
    const before = await verificationIds();
    const res = await postLogin(
      { email: "per-ip@example.test", "cf-turnstile-response": LOGIN_TOKEN },
      { headers: { "cf-connecting-ip": ip } },
    );
    await expectTooManyRequests(res);
    await expectNothingCreated("per-ip@example.test", before);

    // A cross-site request from it is still refused as one, before the limit is asked.
    const crossSite = await postLogin(
      { email: "per-ip@example.test", "cf-turnstile-response": LOGIN_TOKEN },
      { headers: { "cf-connecting-ip": ip, origin: "https://evil.example" } },
    );
    expect(crossSite.status).toBe(403);
    // Another IP is not held up.
    const other = await postLogin(
      { email: "per-ip@example.test", "cf-turnstile-response": LOGIN_TOKEN },
      { headers: { "cf-connecting-ip": freshIp() } },
    );
    expect(other.status).toBe(200);
  });

  it("Login requests are rate-limited per email", async () => {
    await windowHeadroom(LOGIN_WINDOW_SECONDS);
    const email = `per-email-${crypto.randomUUID()}@example.test`;
    // The limit's worth of links, each asked for from another IP (postLogin's fresh one).
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
      expect(res.status).toBe(200);
    }
    expect(await emailsTo(email, { atLeast: LOGIN_EMAIL_LIMIT })).toHaveLength(LOGIN_EMAIL_LIMIT);

    // From yet another IP, and spelt differently: the same address.
    const before = await verificationIds();
    const res = await postLogin({
      email: ` ${email.toUpperCase()} `,
      "cf-turnstile-response": LOGIN_TOKEN,
    });
    await expectTooManyRequests(res);
    // No token, however the address would have been stored: matched in any case and
    // spacing. By address, since other test files issue tokens at the same time.
    const made = await db
      .selectFrom("verification")
      .select("id")
      .where("value", "ilike", `%${email}%`)
      .execute();
    expect(made.filter((row) => !before.has(row.id))).toEqual([]);
    // Nothing more queued: a later request's email has arrived, and still only those.
    await queuedFor(email);
    expect(await emailsTo(email)).toHaveLength(LOGIN_EMAIL_LIMIT);
  });

  it("One address gets at most 5 sign-in emails a day", async () => {
    expect(env.LOGIN_EMAIL_QUOTA).toBe("5");
    const email = `daily-${crypto.randomUUID()}@example.test`;
    await setCountToday(email, 4);

    const fifth = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
    expect(fifth.status).toBe(200);
    expect(await emailsTo(email)).toHaveLength(1);
    expect(await countToday(email)).toBe(5);

    // From another IP, and spelt differently: the same address.
    const before = await verificationIds();
    const sixth = await postLogin({
      email: ` ${email.toUpperCase()} `,
      "cf-turnstile-response": LOGIN_TOKEN,
    });
    expect(sixth.status).toBe(429);
    // Until the next midnight UTC, whichever way the page and the header say it.
    const retryAfter = Number(sixth.headers.get("retry-after"));
    expect(Math.abs(retryAfter - secondsToReset(new Date()))).toBeLessThan(60);
    expect(sixth.headers.get("cache-control")).toBe("no-store");
    const html = await sixth.text();
    expect(html).toContain("Too many requests");
    expect(html).toContain("Please try again after midnight UTC.");

    expect(await countToday(email)).toBe(5);
    // No token, however the address would have been stored.
    const made = await db
      .selectFrom("verification")
      .select("id")
      .where("value", "ilike", `%${email}%`)
      .execute();
    expect(made.filter((row) => !before.has(row.id))).toEqual([]);
    // Nothing more queued: a later request's email has arrived, and still only the one.
    await queuedFor(email);
    expect(await emailsTo(email)).toHaveLength(1);
  });

  it("A plus tag or a dot makes another address for the daily count", async () => {
    const local = `daily-${crypto.randomUUID()}`;
    await setCountToday(`${local}@example.test`, 5);
    for (const other of [`${local}+tag@example.test`, `${local}.x@example.test`]) {
      const res = await postLogin({ email: other, "cf-turnstile-response": LOGIN_TOKEN });
      expect(res.status, other).toBe(200);
    }
  });

  it("The count starts again the next day", async () => {
    const email = `daily-${crypto.randomUUID()}@example.test`;
    await setCountToday(email, 5, sql<string>`(now() at time zone 'utc')::date - 1`);

    const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });

    expect(res.status).toBe(200);
    expect(await emailsTo(email)).toHaveLength(1);
    expect(await countToday(email)).toBe(1);
  });

  it("The daily limit comes from the configuration", async () => {
    const email = `daily-${crypto.randomUUID()}@example.test`;
    const post = async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        loginRequest({ email, "cf-turnstile-response": LOGIN_TOKEN }),
        { ...env, LOGIN_EMAIL_QUOTA: "1" },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    expect([await post(), await post()]).toEqual([200, 429]);
  });

  it("The daily count holds a keyed hash of the address, not the address", async () => {
    const email = `daily-${crypto.randomUUID()}@example.test`;
    const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
    expect(res.status).toBe(200);

    // Found under the hash, which ip-hash.node.test.ts pins to a literal.
    expect(await countToday(email)).toBe(1);
  });

  it("The privacy page says what the daily count keeps", async () => {
    const html = await (await fetchW("/privacy")).text();
    expect(html).toContain("a keyed hash of the address");
    expect(html).toContain("A day's count is deleted");
  });

  it("The per-minute limits and Turnstile run first, so they cost the daily count nothing", async () => {
    await windowHeadroom(LOGIN_WINDOW_SECONDS);
    const email = `daily-${crypto.randomUUID()}@example.test`;
    const passing = { email, "cf-turnstile-response": LOGIN_TOKEN };

    // Turnstile refuses it.
    const failed = await postLogin({ email, "cf-turnstile-response": "a-failing-token" });
    expect(failed.status).toBe(400);
    expect(await countToday(email)).toBeNull();

    // The limit per IP catches it.
    const ip = freshIp();
    await fillIpLimit(ip);
    await expectTooManyRequests(await postLogin(passing, { headers: { "cf-connecting-ip": ip } }));
    expect(await countToday(email)).toBeNull();

    // The limit per address catches the one after these.
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      expect((await postLogin(passing)).status).toBe(200);
    }
    await expectTooManyRequests(await postLogin(passing));
    expect(await countToday(email)).toBe(LOGIN_EMAIL_LIMIT);
  });

  it("Sign-in still goes through when the daily count can't be made, and logs no address", async () => {
    const email = `daily-down-${crypto.randomUUID()}@example.test`;
    // A key the hash can't be made with: the count fails, as it would with the table away.
    const broken = { ...env, IP_HASH_KEY: "" };
    let status = 0;
    const logged = await consoleDuring(async () => {
      const ctx = createExecutionContext();
      const request = loginRequest({ email, "cf-turnstile-response": LOGIN_TOKEN });
      status = (await app.fetch(request, broken, ctx)).status;
      await waitOnExecutionContext(ctx);
    });

    expect(status).toBe(200);
    expect(await emailsTo(email)).toHaveLength(1);
    expect(await countToday(email)).toBeNull();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("daily-down");
  });

  it("Sign-in requests with no address are refused as such, not counted together", async () => {
    await windowHeadroom(LOGIN_WINDOW_SECONDS);
    for (let i = 0; i <= LOGIN_EMAIL_LIMIT; i++) {
      const res = await postLogin({ email: " ", "cf-turnstile-response": LOGIN_TOKEN });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('<p role="alert">Enter a valid email address.</p>');
    }
  });

  it("A refused request sets no marker", async () => {
    const refused = async (
      status: number,
      fields: Record<string, string>,
      options?: Parameters<typeof postLogin>[1],
    ) => {
      const res = await postLogin(fields, options);
      expect(res.status).toBe(status);
      expect(res.headers.getSetCookie()).toEqual([]);
    };
    const email = "marker-refused@example.test";
    const passing = { email, "cf-turnstile-response": LOGIN_TOKEN };

    // The origin check, Turnstile, the address and the size.
    await refused(403, passing, { headers: { origin: "https://evil.example" } });
    await refused(400, { email, "cf-turnstile-response": "a-failing-token" });
    await refused(503, { email, "cf-turnstile-response": "siteverify-down" });
    for (const bad of ["not-an-address", " ", `a${LONGEST_EMAIL}`]) {
      await refused(400, { email: bad, "cf-turnstile-response": LOGIN_TOKEN });
    }
    await refused(413, {}, { body: `email=x&padding=${"x".repeat(17 * 1024)}` });

    // The limit per IP.
    await windowHeadroom(LOGIN_WINDOW_SECONDS);
    const ip = freshIp();
    await fillIpLimit(ip);
    await refused(429, passing, { headers: { "cf-connecting-ip": ip } });

    // The limit per address.
    const limited = `marker-limited-${crypto.randomUUID()}@example.test`;
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      const res = await postLogin({ email: limited, "cf-turnstile-response": LOGIN_TOKEN });
      expect(res.status).toBe(200);
    }
    await refused(429, { email: limited, "cf-turnstile-response": LOGIN_TOKEN });

    // The daily limit per address.
    const spent = `marker-spent-${crypto.randomUUID()}@example.test`;
    await setCountToday(spent, 5);
    await refused(429, { email: spent, "cf-turnstile-response": LOGIN_TOKEN });
  });

  it("An accepted request sets the marker the same way whether or not the address has an account", async () => {
    const existing = "marker-account@example.test";
    await signIn(existing);

    for (const email of [existing, "marker-no-account@example.test"]) {
      const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
      expect(res.status, email).toBe(200);
      // Exactly this: a fixed value that holds nothing about the address, the token or
      // the account, no Domain, and the link's 15 minutes.
      expect(res.headers.getSetCookie(), email).toEqual([
        "__Host-signin-pending=1; Max-Age=900; Path=/; SameSite=Lax; Secure; HttpOnly",
      ]);
    }
  });

  it("Sign-in requests Turnstile refuses don't count against the address", async () => {
    // No wait for headroom: a new window could only let the last request through.
    const email = "per-email-unsolved@example.test";
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      const res = await postLogin({ email, "cf-turnstile-response": "a-failing-token" });
      expect(res.status).toBe(400);
    }
    const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
    expect(res.status).toBe(200);
  });
});

describe("19-surge-controls-and-quotas", () => {
  it("Turnstile guards login and signup", async () => {
    const before = await verificationIds();
    const res = await postLogin({ email: "surge-turnstile@example.test" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(formTag(html)).not.toBeNull();
    expect(html).toContain('<p role="alert">');
    await expectNothingCreated("surge-turnstile@example.test", before);
  });

  it("Login is throttled per IP", async () => {
    await windowHeadroom(LOGIN_WINDOW_SECONDS);
    const ip = freshIp();
    await fillIpLimit(ip);
    const res = await postLogin(
      { email: "surge-per-ip@example.test", "cf-turnstile-response": LOGIN_TOKEN },
      { headers: { "cf-connecting-ip": ip } },
    );

    // Retry-After in whole seconds, and the page says the same wait.
    const html = await expectTooManyRequests(res);
    expect(html).toContain("<h1>Too many requests</h1>");
    // A plain page: no form and no script, under the same CSP as every page, never cached.
    expect(html).not.toMatch(/<form|<script/);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("Sign-in failures", () => {
  it("A failing sign-in request logs no address", async () => {
    // The same app, with a queue that refuses the email with an error naming the
    // address. Miniflare's queue can't be made to fail, so this one stands in for it.
    let sends = 0;
    const queue: Queue<EmailMessage> = {
      send: async (message) => {
        sends += 1;
        throw new Error(`queue refused the email to ${message.to}`);
      },
      sendBatch: async () => {
        throw new Error("queue refused the batch");
      },
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    };
    const refusing = { ...env, EMAIL: queue };
    let status = 0;
    let markers: string[] = [];
    const logged = await consoleDuring(async () => {
      const ctx = createExecutionContext();
      const request = loginRequest({
        email: "logged-nowhere@example.test",
        "cf-turnstile-response": LOGIN_TOKEN,
      });
      const res = await app.fetch(request, refusing, ctx);
      status = res.status;
      markers = res.headers.getSetCookie();
      await waitOnExecutionContext(ctx);
    });
    // It failed where the error names the address, and no link went out, so no marker either.
    expect(sends).toBe(1);
    expect(status).toBe(500);
    expect(markers).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("logged-nowhere");
  });

  it("A failing rate limiter lets sign-in through and logs no address, IP or key", async () => {
    // Both limits fail with an error naming what they were asked about.
    const keys: string[] = [];
    const failing: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        throw new Error(`limiter refused ${key}`);
      },
    };
    const broken = { ...env, LOGIN_IP_LIMIT: failing, LOGIN_EMAIL_LIMIT: failing };
    const request = loginRequest({
      email: "limiter-down@example.test",
      "cf-turnstile-response": LOGIN_TOKEN,
    });
    const ip = request.headers.get("cf-connecting-ip") ?? "no client address";
    let status = 0;
    const logged = await consoleDuring(async () => {
      const ctx = createExecutionContext();
      status = (await app.fetch(request, broken, ctx)).status;
      await waitOnExecutionContext(ctx);
    });

    // Turnstile still guards the form, so the link is sent.
    expect(status).toBe(200);
    expect(await emailsTo("limiter-down@example.test")).toHaveLength(1);
    expect(logged.length).toBeGreaterThan(0);
    const log = logged.join("\n");
    for (const secret of ["limiter-down", ip, ...keys]) expect(log).not.toContain(secret);
  });
});
