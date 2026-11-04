import { describe, expect, it } from "vitest";
import { BASE, fetchW, WAITLIST_TOKEN, STRICT, withoutNonce } from "./helpers";

// Runs in the "open" project: PRELAUNCH off, the archive open.

describe("22-waitlist after launch", () => {
  it("POST /waitlist answers 404 and GET /waitlist goes home", async () => {
    const res = await fetchW("/waitlist", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({
        email: "after-launch@example.test",
        "cf-turnstile-response": WAITLIST_TOKEN,
      }).toString(),
    });
    expect(res.status).toBe(404);
    // No form, so no Turnstile frame.
    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);

    const page = await fetchW("/waitlist");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/");
  });
});
