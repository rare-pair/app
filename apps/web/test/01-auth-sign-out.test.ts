import { createDb } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { BASE, consoleDuring, fetchW, postLogin, signIn } from "./helpers";

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
    // The attribute, not the `__Secure-` in the cookie's name.
    expect(cleared[0]).toMatch(/;\s*Secure(;|$)/);
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
    const signedOut = await postLogout(old);
    // What an observer sees: the status and every header but the date, and the body.
    const seen = async (res: Response) => ({
      status: res.status,
      headers: [...res.headers].filter(([name]) => name !== "date"),
      body: await res.text(),
    });
    const expected = await seen(signedOut);
    expect(expected.status).toBe(303);
    expect(expected.headers).toContainEqual(["clear-site-data", '"cache"']);
    // The last is a second tab: a real cookie whose session was just signed out.
    for (const cookie of [undefined, "__Secure-better-auth.session_token=forged.value", old]) {
      expect(await seen(await postLogout(cookie))).toEqual(expected);
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
    const makeDue = () =>
      db
        .updateTable("session")
        .set({ expires_at: new Date(Date.now() + 5 * 24 * 60 * 60_000) })
        .where("user_id", "=", user.id)
        .execute();
    await makeDue();
    // The control: a read of this session does hand back a refreshed session cookie, so the
    // post below meets a refresh the session middleware wants to add.
    const read = await fetchW("/logout", { headers: { cookie } });
    expect(
      read.headers
        .getSetCookie()
        .some(
          (c) => c.startsWith("__Secure-better-auth.session_token=") && !c.includes("Max-Age=0"),
        ),
    ).toBe(true);
    await makeDue();

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

    // Each header alone, from the site, is enough: the check refuses what is foreign, and
    // doesn't need both.
    const alone: Record<string, string>[] = [{ origin: BASE }, { "sec-fetch-site": "same-origin" }];
    for (const headers of alone) {
      const mine = await signIn(`sign-out-one-header-${Object.keys(headers)[0]}@example.test`);
      const res = await fetchW("/logout", {
        method: "POST",
        headers: { cookie: mine, ...headers },
      });
      expect(res.status, JSON.stringify(headers)).toBe(303);
    }
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
    expect(html).toContain('href="/login"');
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

  describe("Sign-out says so when the session row can't be deleted", () => {
    /**
     * Makes deleting `userId`'s session rows fail in Postgres, runs `run`, and removes the
     * trigger. Scoped to one user: the database serves every test file at once.
     */
    async function whileDeleteFails(userId: string, run: () => Promise<void>) {
      const name = `out2_${userId.replace(/\W/g, "_")}`;
      await sql
        .raw(
          `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delete refused'; END $$;
           CREATE TRIGGER ${name} BEFORE DELETE ON session FOR EACH ROW WHEN (OLD.user_id = '${userId}') EXECUTE FUNCTION ${name}()`,
        )
        .execute(db);
      try {
        await run();
      } finally {
        await sql.raw(`DROP TRIGGER ${name} ON session; DROP FUNCTION ${name}()`).execute(db);
      }
    }

    it("A failed delete does not report a successful sign-out", async () => {
      const email = "sign-out-delete-fails@example.test";
      const cookie = await signIn(email, { acceptTerms: true });
      const user = await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirstOrThrow();

      await whileDeleteFails(user.id, async () => {
        const res = await postLogout(cookie);

        expect(res.status).toBe(500);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("clear-site-data")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.getSetCookie()).toEqual([]);
        const html = await res.text();
        expect(html).toContain("try again");
        expect(html).toContain('action="/logout"');
        expect(html).not.toMatch(/signed out/i);
        expect(await sessionRows(email)).toBe(1);
        // The cookie still works, and the retry is a plain post of the same button.
        expect((await fetchW("/me/uploads", { headers: { cookie } })).status).toBe(200);
      });

      // The database recovers: the same button now signs out.
      const retry = await postLogout(cookie);
      expect(retry.status).toBe(303);
      expect(retry.headers.get("clear-site-data")).toBe('"cache"');
      expect(await sessionRows(email)).toBe(0);
    });

    it("Sign-out with the database unreachable is not a success and logs no address", async () => {
      const cookie = await signIn("sign-out-db-down@example.test", { acceptTerms: true });
      const down = {
        ...env,
        HYPERDRIVE: { connectionString: "postgresql://nobody:nothing@127.0.0.1:1/none" },
      };
      let res = null as Response | null;
      const logged = await consoleDuring(async () => {
        const ctx = createExecutionContext();
        const request = new Request(`${BASE}/logout`, {
          method: "POST",
          headers: { cookie, origin: BASE },
        });
        res = await app.fetch(request, down, ctx);
        await waitOnExecutionContext(ctx);
      });

      // SAFETY: assigned in the callback above, which has run.
      const answered = res as unknown as Response;
      expect(answered.status).toBeGreaterThanOrEqual(500);
      expect(answered.headers.getSetCookie()).toEqual([]);
      expect(answered.headers.get("clear-site-data")).toBeNull();
      expect(logged.join("\n")).not.toContain("example.test");
    });
  });
});
