import { describe, expect, it } from "vitest";
import { acceptTerms, BASE, fetchW, signIn } from "./helpers";

// Runs in the "prelaunch" project, with PRELAUNCH turned on (wrangler.jsonc has it off).
// The terms gate runs after the pre-launch redirect, so a closed page still goes to
// the coming-soon page, and the open ones a new account needs still open.

const get = (path: string, cookie: string) => fetchW(path, { headers: { cookie } });

describe("01-auth-magic-link before launch", () => {
  it("Before launch, a new account can still read and accept the terms", async () => {
    const cookie = await signIn("prelaunch-terms@example.test");

    for (const path of ["/welcome/terms", "/terms", "/privacy"]) {
      expect((await get(path, cookie)).status, path).toBe(200);
    }
    // A closed page goes to the coming-soon page first, as for everyone.
    const closed = await get("/works/13001", cookie);
    expect(closed.status).toBe(302);
    expect(closed.headers.get("location")).toBe("/");
    // An open page that isn't exempt, the coming-soon page, goes to the terms page.
    const home = await get("/", cookie);
    expect(home.status).toBe(302);
    const location = new URL(home.headers.get("location")!, BASE);
    expect(location.pathname).toBe("/welcome/terms");
    expect(location.searchParams.get("next")).toBe("/");

    await acceptTerms(cookie);
    expect((await get("/", cookie)).status).toBe(200);
  });
});
