import wrangler from "../wrangler.jsonc?raw";
import { describe, expect, it } from "vitest";

interface ContentConfig {
  observability: {
    enabled?: boolean;
    redact_query_string?: boolean;
    logs?: { enabled?: boolean; invocation_logs?: boolean };
    traces?: { enabled?: boolean };
  };
}

// wrangler.jsonc without its comments and trailing commas: strings are kept whole, so a `//`
// inside one survives.
function readConfig(): ContentConfig {
  const json = wrangler
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the tests read only `observability`, from the file's own JSON.
  return JSON.parse(json) as ContentConfig;
}

describe("24-crawler-and-agent-blocking", () => {
  it("Content origin refusals log no URL: traces are off", () => {
    expect(readConfig().observability.traces?.enabled).toBe(false);
  });

  it("Content origin refusals log no URL: invocation logs are off", () => {
    expect(readConfig().observability.logs?.invocation_logs).toBe(false);
  });

  it("Query strings are redacted from stored logs: redact_query_string is on", () => {
    expect(readConfig().observability.redact_query_string).toBe(true);
  });

  it("Content origin errors and metrics are kept", () => {
    const { observability } = readConfig();
    expect(observability.enabled).toBe(true);
    expect(observability.logs?.enabled).toBe(true);
  });
});
