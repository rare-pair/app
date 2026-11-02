// The queues and the job's timings, which must agree with the queue consumers in wrangler.jsonc
// (test/queue-config.node.test.ts checks them).

/** The uploads' queue, and the re-sanitize backfill's: the Worker consumes no other. */
export const INGEST_QUEUE = "ingest";
export const BACKFILL_QUEUE = "ingest-backfill";

/** Mirrors `max_retries`: a message is delivered up to this many times after the first. */
export const MAX_RETRIES = 3;

/** How long a job holds its upload. Under `retry_delay`, so a retry finds a dead job's lease expired. */
export const LEASE_SECONDS = 60;
