import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, postLogin, signIn } from "./helpers";

// Sign-out at /logout (OUT). Each test signs in its own account, found by address.

const db = createDb({
  connectionString: env.HYPERDRIVE.connectionString,
  max: 1,
});
afterAll(() => db.destroy());

/** How many session rows the account has. */
async function sessionRows(email: string) {
  const rows = await db
    .selectFrom("session")
    .innerJoin("user", "user.id", "session.user_id")
    .select("session.id")
    .where("user.email", "=", email)
    .execute();
  return rows.length;
}

/** POST /logout as the site's own form posts it, with `cookie` if given. */
function postLogout(cookie?: string, extra: Record<string, string> = {}) {
  const headers = { ...extra };
  if (cookie !== undefined) headers.cookie = cookie;
  return postLogin({}, { url: "/logout", headers });
}

describe("01-auth-magic-link sign-out", () => {
  it("Sign-out ends the session and clears the cookie", async () => {
    const email = "sign-out-post@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    expect(await sessionRows(email)).toBe(1);

    const res = await postLogout(cookie);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cleared = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith("__Secure-better-auth.session_token="));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/^__Secure-better-auth\.session_token=;/);
    expect(cleared[0]).toContain("Max-Age=0");
    expect(cleared[0]).toContain("Path=/");
    expect(cleared[0]).toContain("HttpOnly");
    expect(cleared[0]).toContain("Secure");
    expect(cleared[0]).toContain("SameSite=Lax");
    expect(cleared[0]).not.toMatch(/Domain=/i);
    expect(await sessionRows(email)).toBe(0);
  });

  it("Sign-out empties the browser's cache and keeps the reader's settings", async () => {
    const cookie = await signIn("sign-out-cache@example.test", {
      acceptTerms: true,
    });

    const res = await postLogout(cookie);

    // Quotes included: a Clear-Site-Data value without them is ignored.
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
    // Only the Better Auth cookies are cleared, none of the reader's own.
    for (const c of res.headers.getSetCookie()) expect(c).toMatch(/^__Secure-better-auth\./);
  });

  it("Sign-out without a session answers the same", async () => {
    const old = await signIn("sign-out-same@example.test");
    const signedIn = await postLogout(old);
    // The last is a second tab: a real cookie whose session was just signed out.
    for (const cookie of [undefined, "__Secure-better-auth.session_token=forged.value", old]) {
      const res = await postLogout(cookie);
      expect(res.status).toBe(signedIn.status);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("clear-site-data")).toBe('"cache"');
      expect(
        res.headers
          .getSetCookie()
          .some((c) => c.startsWith("__Secure-better-auth.session_token=;")),
      ).toBe(true);
    }
  });

  it("A refresh due on the sign-out request does not undo it", async () => {
    const email = "sign-out-refresh@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    const user = await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    // Two days old of seven: Better Auth extends it on the next lookup.
    await db
      .updateTable("session")
      .set({ expires_at: new Date(Date.now() + 5 * 24 * 60 * 60_000) })
      .where("user_id", "=", user.id)
      .execute();

    const res = await postLogout(cookie);

    const sessionCookies = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith("__Secure-better-auth.session_token="));
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]).toContain("Max-Age=0");
    expect(await sessionRows(email)).toBe(0);
  });

  it("A cross-site sign-out is refused", async () => {
    const email = "sign-out-cross-site@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    const cross: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of cross) {
      const res = await postLogout(cookie, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get("clear-site-data")).toBeNull();
      // It doesn't send the person to sign in.
      expect(await res.text()).not.toContain("/login");
    }
    // Neither header at all.
    const bare = await fetchW("/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(bare.status).toBe(403);
    expect(bare.headers.getSetCookie()).toEqual([]);

    expect(await sessionRows(email)).toBe(1);
    expect((await fetchW("/logout", { headers: { cookie } })).status).toBe(200);
    expect(await (await fetchW("/logout", { headers: { cookie } })).text()).toContain(
      'action="/logout"',
    );
  });

  it("Opening the sign-out page signs nobody out", async () => {
    const email = "sign-out-get@example.test";
    const cookie = await signIn(email, { acceptTerms: true });

    for (const method of ["GET", "HEAD"]) {
      const res = await fetchW("/logout", { method, headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get("clear-site-data")).toBeNull();
      expect(res.headers.get("cache-control")).toContain("no-store");
      if (method === "GET") {
        const html = await res.text();
        expect(html).toContain('<form method="post" action="/logout">');
        expect(html).toContain("<button");
        expect(html).not.toContain("<script");
      }
    }
    expect(await sessionRows(email)).toBe(1);
    // Still signed in on another page that needs an account.
    expect((await fetchW("/me/uploads", { headers: { cookie } })).status).toBe(200);
  });

  it("The sign-out page says when nobody is signed in", async () => {
    const res = await fetchW("/logout");

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You are not signed in");
    expect(html).not.toContain('action="/logout"');
  });

  it("A signed-out cookie reads as signed out", async () => {
    const email = "sign-out-old-cookie@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    await postLogout(cookie);

    const page = await fetchW("/logout", { headers: { cookie } });
    expect(await page.text()).toContain("You are not signed in");
    const mine = await fetchW("/me/uploads", { headers: { cookie } });
    expect(mine.status).toBe(302);
    expect(new URL(mine.headers.get("location")!, "https://rarepair.fans").pathname).toBe("/login");
    expect(await sessionRows(email)).toBe(0);
  });

  it("Sign-out works before launch and before the terms are accepted", async () => {
    const email = "sign-out-no-terms@example.test";
    const cookie = await signIn(email);

    // The gate would send any other page to /welcome/terms.
    const page = await fetchW("/logout", { headers: { cookie } });
    expect(page.status).toBe(200);
    const res = await postLogout(cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(await sessionRows(email)).toBe(0);
  });
});
