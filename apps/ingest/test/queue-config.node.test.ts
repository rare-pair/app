import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BACKFILL_QUEUE,
  INGEST_DLQ,
  INGEST_QUEUE,
  LEASE_RENEW_SECONDS,
  LEASE_SECONDS,
  MAX_RETRIES,
} from "../src/config";

// The queue's batching, concurrency, retries and dead-letter queue are Cloudflare's to enforce,
// from wrangler.jsonc: no local run shows them. This checks the config that deploys.

interface Consumer {
  queue: string;
  max_batch_size: number;
  max_concurrency: number;
  max_retries: number;
  retry_delay: number;
  dead_letter_queue?: string;
}

/** The consumers in wrangler.jsonc, read with its line comments and trailing commas removed. */
function consumers(): Consumer[] {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the fields read from it are each checked by the assertions that read them.
  const config = JSON.parse(text) as { queues: { consumers: Consumer[] } };
  return config.queues.consumers;
}

/** The consumer of `queue` in wrangler.jsonc. */
function consumerOf(queue: string): Consumer {
  const found = consumers().find((c) => c.queue === queue);
  if (found === undefined) throw new Error(`wrangler.jsonc has no consumer of ${queue}`);
  return found;
}

/** The ingest queue's consumer. */
const consumer = () => consumerOf("ingest");

describe("04-ingest-job-lifecycle", () => {
  it("Consumer concurrency stays bounded under a flood", () => {
    expect(consumer()).toMatchObject({ queue: "ingest", max_concurrency: 2 });
  });

  it("One upload is handled per invocation", () => {
    // So a crash in one job has no batch-mate to spend the retries of.
    expect(consumer().max_batch_size).toBe(1);
  });

  it("The dead-letter consumer outlasts a short Postgres outage and a dying job's lease", () => {
    const dlq = consumerOf(INGEST_DLQ);
    // One message and one invocation at a time, retried for an hour before it is deleted.
    expect(dlq).toMatchObject({
      max_batch_size: 1,
      max_concurrency: 1,
      max_retries: 30,
      retry_delay: 120,
    });
    // So the next delivery finds the lease of a job that has just died expired.
    expect(dlq.retry_delay).toBeGreaterThan(LEASE_SECONDS);
    // Nothing behind it: a message it can't place is deleted, not moved on.
    expect(dlq.dead_letter_queue).toBeUndefined();
  });

  it("Permanent failure goes to the dead-letter queue as parse_failed", () => {
    expect(consumer()).toMatchObject({ dead_letter_queue: "ingest-dlq", max_retries: 3 });
    // The job's last attempt is the queue's last delivery.
    expect(MAX_RETRIES).toBe(consumer().max_retries);
  });
});

describe("ingest lease", () => {
  it("holds a lease for less than the retry delay", () => {
    // So a retry of a job that died holding its lease finds the lease expired.
    expect(consumer().retry_delay).toBe(120);
    expect(LEASE_SECONDS).toBeLessThan(120);
  });

  it("renews the lease more than once within it", () => {
    // So two renewals can fail in a row without losing a job its upload.
    expect(LEASE_RENEW_SECONDS * 3).toBeLessThan(LEASE_SECONDS);
  });
});

describe("07-sanitizing-and-images", () => {
  it("The backfill queue has its own consumer, one work at a time, dead-lettered", () => {
    // One work a batch and one invocation at once: a backfill run holds one Postgres
    // connection and one epub, and leaves the rest to the ingest queue's uploads.
    expect(consumerOf("ingest-backfill")).toMatchObject({
      max_batch_size: 1,
      max_concurrency: 1,
      max_retries: 3,
      dead_letter_queue: "ingest-backfill-dlq",
    });
  });

  it("The Worker routes the queues wrangler.jsonc binds, and no other", () => {
    // The handler retries a batch from any queue it doesn't name.
    expect(consumers().map((c) => c.queue)).toEqual([INGEST_QUEUE, INGEST_DLQ, BACKFILL_QUEUE]);
  });
});
