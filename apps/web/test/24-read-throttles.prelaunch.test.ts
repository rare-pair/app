import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

// PRELAUNCH turned on (wrangler.jsonc has it off). No work is seeded: a redirect never reads one.
// AO3 work ID 8812790 is this file's.
const W = 8812790;

describe("24-crawler-and-agent-blocking", () => {
  it("Redirects still come first: they spend no read limit", async () => {
    const keys: string[] = [];
    const over: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const limits = { READ_CHAPTER_LIMIT: over, READ_FULL_LIMIT: over };
    const answers: [string, number][] = [
      [`https://rarepair.fans/works/${W}/chapters/1`, 302],
      [`https://rarepair.fans/works/${W}/full`, 302],
      [`https://www.rarepair.fans/works/${W}/chapters/1`, 308],
      [`https://www.rarepair.fans/works/${W}/full`, 308],
    ];
    for (const [url, status] of answers) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(url, { redirect: "manual" }),
        { ...env, ...limits },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, url).toBe(status);
    }
    expect(keys).toEqual([]);
  });
});
