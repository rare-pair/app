import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface QueuesConfig {
  queues: { producers: { binding: string; queue: string }[]; consumers: { queue: string }[] };
}

// wrangler.jsonc without its comments and trailing commas: strings are kept whole.
function readConfig(): QueuesConfig {
  const text = readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8");
  const json = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the test reads only `queues`, from the file's own JSON.
  return JSON.parse(json) as QueuesConfig;
}

describe("22-waitlist", () => {
  it("The web Worker consumes email-bulk-dlq, and still produces to email", () => {
    const { queues } = readConfig();

    expect(queues.consumers.map((c) => c.queue)).toEqual(["email-bulk-dlq"]);
    // Beside the ingest producer that POST /uploads/:id/complete sends to.
    expect(queues.producers).toEqual([
      { binding: "EMAIL", queue: "email" },
      { binding: "INGEST", queue: "ingest" },
    ]);
  });
});
