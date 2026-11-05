import type { Database } from "@archive/db";
import type { Kysely } from "kysely";
import { errorCode } from "./job";
import { claimable } from "./lease";
import { parseMessage } from "./message";

/** Its queries are short, so a stalled connection fails and retries rather than hanging on. */
export const DEAD_LETTER_DB_TIMEOUT_MS = 10_000;

/**
 * The `ingest-dlq` consumer (ARCHITECTURE, EPUB processor, step 8). An upload whose message ran
 * out of deliveries without recording an ending, because each one died first or its ending write
 * failed, is failed here, so its uploader is told and the sweep stops waiting for it.
 *
 * Each message is acked once its upload has an ending. Logs carry upload ids, outcomes and error
 * class names only.
 */
export async function deadLetterBatch(batch: MessageBatch, db: Kysely<Database>): Promise<void> {
  let invalid = 0;
  for (const message of batch.messages) {
    const parsed = parseMessage(message.body);
    if (parsed === null) {
      invalid++;
      message.ack();
      continue;
    }
    const line = {
      event: "ingest.dead_letter",
      uploadId: parsed.upload_id,
      attempt: message.attempts,
    };
    // Caught per message: a throw out of queue() would retry the whole batch.
    try {
      const outcome = await failDeadLettered(db, parsed.upload_id);
      console.log({ ...line, outcome });
      if (outcome === "leased") message.retry();
      else message.ack();
    } catch (error) {
      // Postgres down: retried under this consumer's own max_retries.
      console.error({ ...line, outcome: "retry", error: errorCode(error) });
      message.retry();
    }
  }
  if (invalid > 0) console.warn({ event: "ingest.dead_letter_invalid", count: invalid });
}

/**
 * Sets the upload `parse_failed`, with its stage unknown, only if no job holds it (the rows
 * `claimLease` matches). A duplicate of its message waiting on a retry then finds it ended. An
 * upload left under a live lease says `leased`: a job may still be running, or may have died a
 * moment ago, and the lease alone can't tell. A later delivery finds its ending, or its lease
 * expired.
 */
async function failDeadLettered(
  db: Kysely<Database>,
  uploadId: string,
): Promise<"failed" | "leased" | "finished"> {
  const failed = await db
    .updateTable("uploads")
    .set({ status: "parse_failed", lease_until: null, error_stage: null, error: "dead_lettered" })
    .where("id", "=", uploadId)
    .where(claimable)
    .returning("id")
    .executeTakeFirst();
  if (failed !== undefined) return "failed";
  const row = await db
    .selectFrom("uploads")
    .select("status")
    .where("id", "=", uploadId)
    .executeTakeFirst();
  return row?.status === "pending" || row?.status === "processing" ? "leased" : "finished";
}
