import { describe, expect, it } from "vitest";
import { emailsTo, fetchW, LOGIN_TOKEN, postLogin, postLoginOpen } from "./helpers";

// Runs in the "prelaunch" project, with PRELAUNCH turned on (wrangler.jsonc has it off).
// Sign-in is closed until the archive opens. Addresses are synthetic.

describe("01-auth-magic-link before launch", () => {
  it("Sign-in is closed before launch: no form, and a post sends no email", async () => {
    for (const path of ["/login", "/login?next=%2Fadmin", "/login/confirm?token=x"]) {
      const page = await fetchW(path);
      expect(page.status, path).toBe(302);
      expect(page.headers.get("location"), path).toBe("/");
    }

    const email = "prelaunch-closed@example.test";
    const res = await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    // A link sent before sign-in closed can't start a session either.
    const confirm = await postLogin({ token: "x", next: "/" }, { url: "/login/confirm" });
    expect(confirm.status).toBe(302);
    expect(confirm.headers.get("location")).toBe("/");
    expect(confirm.headers.getSetCookie()).toEqual([]);

    // The queue delivers in order: once a later email arrives, an earlier one would have.
    const sentinel = "prelaunch-closed-sentinel@example.test";
    await postLoginOpen({ email: sentinel, "cf-turnstile-response": LOGIN_TOKEN });
    await emailsTo(sentinel);
    expect(await emailsTo(email, { atLeast: 0 })).toEqual([]);
  });
});
