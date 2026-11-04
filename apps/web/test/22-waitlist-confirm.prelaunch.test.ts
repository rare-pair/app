import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import {
  BASE,
  consoleDuring,
  emailsTo,
  fetchW,
  freshIp,
  WAITLIST_TOKEN,
  STRICT,
  withoutNonce,
} from "./helpers";

// Runs in the "prelaunch" project: wrangler.jsonc as it deploys, PRELAUNCH on.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** An address no other test uses, in lowercase. */
const fresh = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: BASE,
  "sec-fetch-site": "same-origin",
};

const HSTS = "max-age=31536000; includeSubDomains";

/** Submits the join form with a passing Turnstile token, from a fresh IP: one IP is limited. */
const postJoin = (email: string) =>
  fetchW("/waitlist", {
    method: "POST",
    headers: { ...FORM_HEADERS, "cf-connecting-ip": freshIp() },
    body: new URLSearchParams({ email, "cf-turnstile-response": WAITLIST_TOKEN }).toString(),
  });

/** Joins through the Worker and returns the token from the emailed link. */
async function join(email: string): Promise<string> {
  expect((await postJoin(email)).status).toBe(200);
  const emails = await emailsTo(email);
  return new URL(emails[0]!.url).searchParams.get("token") ?? "";
}

/** Opens the emailed link, as a browser or a mail scanner would. */
const openLink = (token: string) => fetchW(`/waitlist/confirm?token=${encodeURIComponent(token)}`);

/** Presses "Confirm": the form a browser posts, with or without JavaScript. */
const confirm = (token: string, headers: Record<string, string> = {}) =>
  fetchW("/waitlist/confirm", {
    method: "POST",
    headers: { ...FORM_HEADERS, ...headers },
    body: new URLSearchParams({ token }).toString(),
  });

/** The row with its time also read as text, to keep Postgres's microseconds. */
const rowOf = (email: string) =>
  db
    .selectFrom("waitlist")
    .selectAll()
    .select((eb) => eb.cast<string>("confirm_sent_at", "text").as("sent_text"))
    .where("email", "=", email)
    .executeTakeFirst();

/** Sets the last email time to this long ago, as an interval Postgres reads. */
const sentAgo = (email: string, interval: string) =>
  db
    .updateTable("waitlist")
    .set({ confirm_sent_at: sql<Date>`now() - ${interval}::interval` })
    .where("email", "=", email)
    .execute();

const REFUSED_TEXT = /used or has expired/;
// The layout escapes the title's apostrophe.
const ON_THE_LIST = "<h1>You&#39;re on the list</h1>";

describe("22-waitlist", () => {
  it("Opening the confirmation link uses nothing up", async () => {
    const email = fresh("opening");
    const token = await join(email);
    const before = await rowOf(email);

    for (let i = 0; i < 2; i++) {
      const res = await openLink(token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
      expect(res.headers.get("strict-transport-security")).toBe(HSTS);
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
      expect(res.headers.get("set-cookie")).toBeNull();
      const html = await res.text();
      expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/waitlist\/confirm"/);
      expect(html).toContain(`name="token" value="${token}"`);
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Confirm<\/button>/);
      // Works with JavaScript off: no script of the page's own.
      expect(html).not.toMatch(/<script/);
    }

    const after = await rowOf(email);
    expect(after!.confirmed_at).toBeNull();
    expect(after).toEqual(before);
  });

  it("A link with no token, or a silly one, shows the refused page and echoes nothing", async () => {
    for (const query of ["", "?token=", `?token=${"a".repeat(300)}`, "?token=%3Cb%3Ex%3C/b%3E"]) {
      const res = await fetchW(`/waitlist/confirm${query}`);
      expect(res.status, query).toBe(400);
      const html = await res.text();
      expect(html, query).toMatch(REFUSED_TEXT);
      expect(html, query).not.toContain("<b>x</b>");
      expect(html, query).not.toContain("aaaaaaaaaaaaaaaaaaaa");
    }
  });

  it("Confirming puts the address on the list", async () => {
    const email = fresh("confirming");
    const token = await join(email);
    const before = (await rowOf(email))!;

    const started = Date.now();
    const res = await confirm(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(ON_THE_LIST);
    expect(html).toMatch(/One email will follow when rarepair opens/);
    // Neither the address nor the token is shown.
    expect(html.toLowerCase()).not.toContain(email);
    expect(html).not.toContain(token);

    const after = (await rowOf(email))!;
    expect(Math.abs(after.confirmed_at!.getTime() - started)).toBeLessThan(60_000);
    expect(after.confirm_token_hash).toBeNull();
    expect(after.notified_at).toBeNull();
    // Nothing else moved.
    expect({ ...after, confirmed_at: null, confirm_token_hash: before.confirm_token_hash }).toEqual(
      before,
    );
  });

  it("Used, expired or unknown confirmation links are refused plainly", async () => {
    const usedEmail = fresh("used");
    const usedToken = await join(usedEmail);
    expect((await confirm(usedToken)).status).toBe(200);
    const usedRow = await rowOf(usedEmail);

    const expiredEmail = fresh("expired");
    const expiredToken = await join(expiredEmail);
    await sentAgo(expiredEmail, "7 days 1 minute");
    const expiredRow = await rowOf(expiredEmail);

    const replacedEmail = fresh("replaced");
    const replacedToken = await join(replacedEmail);
    await sentAgo(replacedEmail, "61 minutes");
    expect((await postJoin(replacedEmail)).status).toBe(200);
    await emailsTo(replacedEmail, { atLeast: 2 });
    const replacedRow = await rowOf(replacedEmail);

    const cases: [string, string][] = [
      ["used", usedToken],
      ["expired", expiredToken],
      ["replaced", replacedToken],
      ["unknown", "A".repeat(43)],
      ["empty", ""],
      ["malformed", "not base64url!!"],
      ["one short", "A".repeat(42)],
      ["one long", "A".repeat(44)],
      ["too long", "A".repeat(300)],
    ];
    for (const [name, token] of cases) {
      const res = await confirm(token);
      expect(res.status, name).toBe(400);
      const html = await res.text();
      expect(html, name).toMatch(REFUSED_TEXT);
      expect(html, name).toMatch(/<a href="\/">/);
      expect(html, name).not.toContain(ON_THE_LIST);
      expect(res.headers.get("set-cookie"), name).toBeNull();
      expect(res.headers.get("strict-transport-security"), name).toBe(HSTS);
    }

    // Nothing changed in any row.
    expect(await rowOf(usedEmail)).toEqual(usedRow);
    expect(await rowOf(expiredEmail)).toEqual(expiredRow);
    expect(await rowOf(replacedEmail)).toEqual(replacedRow);
    expect(expiredRow!.confirmed_at).toBeNull();
    expect(replacedRow!.confirmed_at).toBeNull();
  });

  it("A link just inside 7 days still works", async () => {
    const email = fresh("inside");
    const token = await join(email);
    await sentAgo(email, "6 days 23 hours");
    const res = await confirm(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(ON_THE_LIST);
    expect((await rowOf(email))!.confirmed_at).not.toBeNull();
  });

  it("The newest link works after an older one was replaced", async () => {
    const email = fresh("newest");
    await join(email);
    await sentAgo(email, "61 minutes");
    expect((await postJoin(email)).status).toBe(200);
    const emails = await emailsTo(email, { atLeast: 2 });
    const second = new URL(emails[1]!.url).searchParams.get("token") ?? "";
    expect((await confirm(second)).status).toBe(200);
    expect((await rowOf(email))!.confirmed_at).not.toBeNull();
  });

  it("A confirm posted from another site is refused and changes nothing", async () => {
    const email = fresh("cross-site");
    const token = await join(email);
    const before = await rowOf(email);
    const res = await confirm(token, {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
    expect(await rowOf(email)).toEqual(before);
  });

  it("Two confirm requests with the same token at the same time leave one confirmed row", async () => {
    const email = fresh("at-once");
    const token = await join(email);

    const [a, b] = await Promise.all([confirm(token), confirm(token)]);
    const pages = [
      { status: a.status, html: await a.text() },
      { status: b.status, html: await b.text() },
    ];

    for (const { status, html } of pages) {
      // The list or the plain refused page, never a server error page.
      expect([200, 400]).toContain(status);
      expect(html).not.toContain("Something went wrong");
      expect(html).toMatch(new RegExp(`${ON_THE_LIST}|used or has expired`));
    }
    expect(pages.filter((p) => p.status === 200)).toHaveLength(1);
    const rows = await db
      .selectFrom("waitlist")
      .select("email")
      .where("email", "=", email)
      .execute();
    expect(rows).toHaveLength(1);
    const row = await rowOf(email);
    expect(row!.confirmed_at).not.toBeNull();
    expect(row!.confirm_token_hash).toBeNull();
  });

  it("No log line holds the address, the token or the link", async () => {
    const email = fresh("logged");
    const token = await join(email);
    const lines = await consoleDuring(async () => {
      await openLink(token);
      await confirm(token);
      await confirm(token);
      await confirm("A".repeat(43));
    });
    for (const line of lines) {
      expect(line).not.toContain(email);
      expect(line).not.toContain(token);
    }
  });
});
