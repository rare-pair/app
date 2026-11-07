import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface WebConfig {
  vars?: { PRELAUNCH?: string };
  observability?: {
    enabled?: boolean;
    redact_query_string?: boolean;
    logs?: { enabled?: boolean; invocation_logs?: boolean };
    traces?: { enabled?: boolean };
  };
}

// wrangler.jsonc without its comments and trailing commas: strings are kept whole, so a `//`
// inside one survives.
function readConfig(): WebConfig {
  const text = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  const json = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the tests read only `observability` and `vars.PRELAUNCH`, from the file's own JSON.
  return JSON.parse(json) as WebConfig;
}

// Reads the config only (observability, and PRELAUNCH below): it cannot show what the deployed Worker has, or that the platform
// keeps error lines when invocation logs are off.
describe("24-crawler-and-agent-blocking", () => {
  it("Counting refusals does not log what people read: invocation logs are off", () => {
    expect(readConfig().observability?.logs?.invocation_logs).toBe(false);
  });

  it("Query strings are redacted from stored logs: redact_query_string is on", () => {
    expect(readConfig().observability?.redact_query_string).toBe(true);
  });

  it("Web refusals log no URL: traces are off", () => {
    expect(readConfig().observability?.traces?.enabled).toBe(false);
  });

  it("Web errors and metrics are kept", () => {
    const { observability } = readConfig();
    expect(observability?.enabled).toBe(true);
    expect(observability?.logs?.enabled).toBe(true);
  });
});

// The archive opened on 2026-11-07. A deploy without a --var flag must not close it again.
describe("22-waitlist", () => {
  it("The deployed config says the archive is open: PRELAUNCH is off", () => {
    expect(readConfig().vars?.PRELAUNCH).toBe("off");
  });
});
