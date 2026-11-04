import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { emailsTo, fetchW, LOGIN_TOKEN, postLogin, STRICT, withoutNonce } from "./helpers";

// A2's cases from 01-auth-magic-link (and one from 09-content-origin): the emailed
// link's confirm page, and the POST that signs in. A1's cases are in 01-auth-magic-link.test.ts.

// The Postgres the Worker uses, through the same Hyperdrive binding. One database
// serves every test file of a project, so each test uses its own email address.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Requests a sign-in link for `email` from /login, and returns the link it emails. */
async function signInLink(email: string, next?: string): Promise<URL> {
  const fields = { email, "cf-turnstile-response": LOGIN_TOKEN };
  expect((await postLogin(next === undefined ? fields : { ...fields, next })).status).toBe(200);
  const emails = await emailsTo(email);
  return new URL(emails.at(-1)!.url);
}

/**
 * The ids of the unspent tokens issued to `email`. By address, not by every row:
 * other test files issue tokens at the same time.
 */
const tokensFor = async (email: string) =>
  (
    await db
      .selectFrom("verification")
      .select("id")
      .where("value", "like", `%${JSON.stringify(email)}%`)
      .orderBy("id")
      .execute()
  ).map((r) => r.id);

/** Requests a sign-in link, and returns it with the id of the `verification` row it made. */
async function issued(email: string, next?: string) {
  const before = new Set(await tokensFor(email));
  const link = await signInLink(email, next);
  const made = (await tokensFor(email)).filter((id) => !before.has(id));
  expect(made).toHaveLength(1);
  return { link, row: made[0]!, token: link.searchParams.get("token")! };
}

/** The confirm page's POST, as a browser on rarepair.fans submits it. */
const confirm = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  postLogin(fields, { url: "/login/confirm", headers });

/** The session cookies a response sets. */
const sessionCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => c.startsWith("__Secure-better-auth.session_token="));

/** The id of `email`'s account, or null when it has none. */
const userId = async (email: string) =>
  (await db.selectFrom("user").select("id").where("email", "=", email).executeTakeFirst())?.id ??
  null;

/** How many sessions `email`'s account has: 0 when there is no account. */
async function sessionCount(email: string): Promise<number> {
  const id = await userId(email);
  if (id === null) return 0;
  const rows = await db.selectFrom("session").select("id").where("user_id", "=", id).execute();
  return rows.length;
}

describe("01-auth-magic-link", () => {
  it("Opening the emailed link uses nothing up", async () => {
    const email = "opening@example.test";
    const { link, row } = await issued(email, "/works/1");

    // The link as a mail scanner prefetches it.
    const res = await fetchW(link.href);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<form\b[^>]*method="post"[^>]*action="\/login\/confirm"[^>]*>/);
    expect(html).toMatch(
      new RegExp(`<input type="hidden" name="token" value="${link.searchParams.get("token")}">`),
    );
    expect(html).toContain('<input type="hidden" name="next" value="/works/1">');
    expect(html).toMatch(/<button type="submit">Sign in<\/button>/);

    // The token is still unused and no session is created.
    expect(await tokensFor(email)).toEqual([row]);
    expect(await sessionCount(email)).toBe(0);

    // The token is in the URL: it is never cached, and a referrer carries only the
    // origin. Not no-referrer: under it a browser sends the page's own POST with
    // `Origin: null` (Fetch, "append a request Origin header"), which the origin check refuses.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
  });

  it("Confirming signs the user in", async () => {
    const email = "confirming@example.test";
    const { row, token } = await issued(email);

    const res = await confirm({ token, next: "/" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://rarepair.fans/");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );

    // The token's verification row is deleted, and a session row is created.
    expect(await tokensFor(email)).not.toContain(row);
    expect(await sessionCount(email)).toBe(1);

    // One cookie, with exactly the attributes ARCHITECTURE fixes, and Better Auth's
    // default lifetime of seven days.
    expect(res.headers.getSetCookie()).toHaveLength(1);
    const [cookie] = sessionCookies(res);
    const attributes = cookie!.split(/;\s*/).slice(1);
    expect(attributes.map((a) => a.toLowerCase())).toEqual(
      expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/", "max-age=604800"]),
    );
    // No Domain, so it covers rarepair.fans only, never content.rarepair.fans.
    expect(attributes.some((a) => /^domain=/i.test(a))).toBe(false);
  });

  it("Confirming works without JavaScript", async () => {
    const email = "no-script@example.test";
    const { link } = await issued(email);

    // The page has no script, and its one form posts the link's fields as they are.
    const page = await (await fetchW(link.href)).text();
    expect(page).not.toMatch(/<script/i);
    expect(page.match(/<form\b[^>]*>/g)).toEqual(['<form method="post" action="/login/confirm">']);
    const fields = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map((m) => [
        m[1]!,
        m[2]!,
      ]),
    );

    // Pressing "Sign in" is a plain form post: it signs in and redirects.
    const res = await confirm(fields);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://rarepair.fans/");
    expect(sessionCookies(res)).toHaveLength(1);
    expect(await sessionCount(email)).toBe(1);
  });

  it("Token cannot be used twice", async () => {
    const email = "twice@example.test";
    const { token } = await issued(email);
    expect((await confirm({ token, next: "/" })).status).toBe(303);

    const again = await confirm({ token, next: "/" });
    await expectRefused(again);
    expect(await sessionCount(email)).toBe(1);
  });

  it("Concurrent use of the same token creates at most one session", async () => {
    // Several requests at once to the Worker under test. They share one isolate and
    // one Postgres session (PGlite), so this shows the wiring, not a cross-isolate race.
    const email = "concurrent@example.test";
    const { token } = await issued(email);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => confirm({ token, next: "/" })),
    );
    expect(responses.filter((res) => sessionCookies(res).length === 1)).toHaveLength(1);
    expect(responses.map((res) => res.status)).toEqual([303, 303, 303, 303]);
    expect(
      responses.filter((res) => res.headers.get("location") === "/login?error=INVALID_TOKEN"),
    ).toHaveLength(3);
    expect(await sessionCount(email)).toBe(1);
  });

  it("Expired token is refused", async () => {
    const email = "expired@example.test";
    const { row, token } = await issued(email);
    // Issued more than 15 minutes ago.
    await db
      .updateTable("verification")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("id", "=", row)
      .execute();

    await expectRefused(await confirm({ token, next: "/" }));
    expect(await sessionCount(email)).toBe(0);
  });

  it("Unknown token is refused", async () => {
    // Better Auth records a session's user agent: this one marks the request, since
    // other test files sign in at the same time.
    const agent = "unknown-token-test";
    const res = await confirm(
      { token: "never-issued-0123456789abcdefABCD", next: "/" },
      { "user-agent": agent },
    );
    await expectRefused(res);
    const sessions = await db
      .selectFrom("session")
      .select("id")
      .where("user_agent", "=", agent)
      .execute();
    expect(sessions).toEqual([]);
  });

  it("Sign-in returns the user to where they started", async () => {
    const email = "returns@example.test";
    const { link } = await issued(email, "/works/1");

    // The link's page carries `next` on, and confirming goes back to it.
    const page = await (await fetchW(link.href)).text();
    expect(page).toContain('<input type="hidden" name="next" value="/works/1">');
    const res = await confirm({ token: link.searchParams.get("token")!, next: "/works/1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://rarepair.fans/works/1");
    expect(sessionCookies(res)).toHaveLength(1);
  });

  it("Sign-in never acts as an open redirect", async () => {
    const hostile = [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/a/..//evil.example",
    ];
    for (const [i, next] of hostile.entries()) {
      const email = `open-redirect-${i}@example.test`;
      const { token } = await issued(email);

      // The link's own `next` is anyone's to write: the page reduces it again.
      const link = new URL("/login/confirm", "https://rarepair.fans");
      link.searchParams.set("token", token);
      link.searchParams.set("next", next);
      const page = await (await fetchW(link.href)).text();
      expect(page, next).toContain('<input type="hidden" name="next" value="/">');

      // So does the POST, whatever the form says.
      const res = await confirm({ token, next });
      expect(res.status, next).toBe(303);
      expect(res.headers.get("location"), next).toBe("https://rarepair.fans/");
      expect(sessionCookies(res), next).toHaveLength(1);
    }
  });

  it("New email creates an account on confirm", async () => {
    const email = "brand-new@example.test";
    const { token } = await issued(email);
    expect(await userId(email)).toBeNull();

    const res = await confirm({ token, next: "/" });
    expect(res.status).toBe(303);
    const user = await db
      .selectFrom("user")
      .select(["id", "email_verified", "terms_accepted_at"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    expect(user.terms_accepted_at).toBeNull();
    expect(user.email_verified).toBe(true);
    expect(await sessionCount(email)).toBe(1);
  });

  it("Sign-in page shows no message for an error it doesn't know", async () => {
    for (const error of ["user_not_found", "<script>alert(1)</script>", ""]) {
      const html = await (await fetchW(`/login?error=${encodeURIComponent(error)}`)).text();
      expect(html, error).not.toContain('role="alert"');
      expect(html, error).not.toContain("alert(1)");
    }
  });

  it("A link with no token, or an overlong one, goes to the sign-in page", async () => {
    // Up to 256 characters, eight times a real token's 32, is put in the form.
    const longest = await fetchW(`/login/confirm?token=${"x".repeat(256)}`);
    expect(longest.status).toBe(200);
    expect(await longest.text()).toContain(`name="token" value="${"x".repeat(256)}"`);
    for (const path of [
      "/login/confirm",
      "/login/confirm?token=",
      "/login/confirm?next=/works/1",
      // One past it: never put back into the page.
      `/login/confirm?token=${"x".repeat(257)}`,
    ]) {
      const res = await fetchW(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/login?error=INVALID_TOKEN");
    }
    await expectRefused(await confirm({ next: "/" }));
    await expectRefused(await confirm({ token: "", next: "/" }));
  });

  it("Confirming from another site is refused before the body is read", async () => {
    const email = "cross-site-confirm@example.test";
    const { row, token } = await issued(email);
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      // Same-site isn't enough: every *.rarepair.fans host is same-site.
      { origin: "https://content.rarepair.fans", "sec-fetch-site": "same-site" },
    ]) {
      const res = await confirm({ token, next: "/" }, headers);
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // A POST with neither header is refused too.
    const bare = await fetchW("/login/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, next: "/" }).toString(),
    });
    expect(bare.status).toBe(403);
    // The token is still unspent.
    expect(await tokensFor(email)).toEqual([row]);
    expect(await sessionCount(email)).toBe(0);
  });

  it("An oversized confirm request is refused unread", async () => {
    const email = "oversized-confirm@example.test";
    const { row, token } = await issued(email);
    const res = await confirm({ token, next: "/", padding: "x".repeat(20 * 1024) });
    await expectRefused(res);
    expect(await tokensFor(email)).toEqual([row]);
  });
});

describe("09-content-origin", () => {
  it("App session cookie is not sent to the content origin", async () => {
    // A browser sends a cookie with no Domain attribute back to the host that set it
    // only, so never to content.rarepair.fans. (The content Worker sets no cookie of its
    // own: apps/content/test/content.test.ts.) No browser runs here.
    const { token } = await issued("session-cookie-scope@example.test");
    const res = await confirm({ token, next: "/" });
    const [cookie, ...more] = sessionCookies(res);
    expect(more).toEqual([]);
    expect(cookie).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(cookie).not.toMatch(/;\s*domain=/i);
    expect(cookie).toMatch(/;\s*path=\/(;|$)/i);
  });
});

/**
 * Shows a confirm POST was refused: no session cookie, and a redirect to /login,
 * which shows a plain message that the link is used or expired.
 */
async function expectRefused(res: Response) {
  expect(res.status).toBe(303);
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(res.headers.get("location")).toBe("/login?error=INVALID_TOKEN");

  const page = await fetchW(res.headers.get("location")!);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(
    '<p role="alert">That sign-in link was used or has expired. Request a new one.</p>',
  );
}
