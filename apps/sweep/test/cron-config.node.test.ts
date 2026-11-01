import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The cron schedule is Cloudflare's to keep, from wrangler.jsonc: no local run fires it. This
// checks the config that deploys.

interface Config {
  triggers: { crons: string[] };
  r2_buckets: { binding: string }[];
  hyperdrive: { binding: string }[];
}

/** wrangler.jsonc, read with its line comments and trailing commas removed. */
function config(): Config {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the fields read from it are each checked by the assertions that read them.
  return JSON.parse(text) as Config;
}

describe("sweep schedule", () => {
  it("The sweep runs once a day", () => {
    const crons = config().triggers.crons;
    expect(crons).toHaveLength(1);
    // Minute and hour fixed; every day of every month, whatever the weekday. UTC, as all crons.
    const [minute, hour, ...rest] = (crons[0] ?? "").split(" ");
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect(rest).toEqual(["*", "*", "*"]);
  });

  it("The sweep reaches R2 and Postgres through its own bindings", () => {
    const c = config();
    expect(c.r2_buckets.map((b) => b.binding)).toEqual(["BUCKET"]);
    expect(c.hyperdrive.map((h) => h.binding)).toEqual(["HYPERDRIVE"]);
  });
});
