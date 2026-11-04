import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

// Runs in the "prelaunch" project: wrangler.jsonc as it deploys, PRELAUNCH on.

describe("22-waitlist", () => {
  it("Privacy notice covers the wait list", async () => {
    const res = await fetchW("/privacy");
    expect(res.status).toBe(200);
    // One list item, so the claims are checked together, as the notice makes them.
    const html = await res.text();
    const item = /<li>The wait list:[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(item).not.toBe("");
    // Only the address, hashed tokens and the email times are kept.
    expect(item).toMatch(/only your email address, hashed confirmation and unsubscribe tokens/);
    expect(item).toMatch(/times we emailed you/);
    // One confirmation email and one launch email.
    expect(item).toMatch(/a confirmation email, and one launch email/);
    // Deleted after launch.
    expect(item).toMatch(/delete the list once the launch emails have been sent/);
  });
});
