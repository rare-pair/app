import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, postLogin, signIn } from "./helpers";

// Runs in the "prelaunch" project, with PRELAUNCH on as wrangler.jsonc deploys it:
// an admin signed in before launch can still sign out.

const db = createDb({
  connectionString: env.HYPERDRIVE.connectionString,
  max: 1,
});
afterAll(() => db.destroy());

describe("01-auth-magic-link sign-out before launch", () => {
  it("Sign-out works before launch and before the terms are accepted", async () => {
    const email = "prelaunch-sign-out@example.test";
    const cookie = await signIn(email);
    const rows = () =>
      db
        .selectFrom("session")
        .innerJoin("user", "user.id", "session.user_id")
        .select("session.id")
        .where("user.email", "=", email)
        .execute();

    const page = await fetchW("/logout", { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('action="/logout"');

    const cross = await postLogin(
      {},
      { url: "/logout", headers: { cookie, origin: "https://evil.example" } },
    );
    expect(cross.status).toBe(403);
    expect(await rows()).toHaveLength(1);

    const res = await postLogin({}, { url: "/logout", headers: { cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith("__Secure-better-auth.session_token=;")),
    ).toBe(true);
    expect(await rows()).toHaveLength(0);
  });
});
