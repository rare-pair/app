import wrangler from "../wrangler.jsonc?raw";
import { describe, expect, it } from "vitest";

interface MailerConfig {
  queues: { consumers: { queue: string }[] };
}

// wrangler.jsonc without its comments and trailing commas: strings are kept whole, so a `//`
// inside one survives.
function readConfig(): MailerConfig {
  const json = wrangler
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the tests read only `queues` and the top-level keys, from the file's own JSON.
  return JSON.parse(json) as MailerConfig;
}

describe("22-waitlist", () => {
  it("The mailer consumes email-bulk with email-bulk-dlq as its dead-letter queue", () => {
    const { consumers } = readConfig().queues;

    expect(consumers.find((c) => c.queue === "email-bulk")).toMatchObject({
      dead_letter_queue: "email-bulk-dlq",
      max_concurrency: 1,
      max_retries: 2,
      retry_delay: 300,
    });
    // The sign-in consumer is as it was.
    expect(consumers.find((c) => c.queue === "email")).toMatchObject({
      max_batch_size: 100,
      max_batch_timeout: 5,
      max_concurrency: 1,
      max_retries: 2,
      retry_delay: 60,
      dead_letter_queue: "email-dlq",
    });
  });

  it("The mailer still has no database, KV or R2 binding", () => {
    const keys = Object.keys(readConfig());

    for (const binding of ["hyperdrive", "kv_namespaces", "r2_buckets", "d1_databases"]) {
      expect(keys).not.toContain(binding);
    }
  });
});
