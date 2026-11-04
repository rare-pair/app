import { createDb } from "@archive/db";
import { parseMessage } from "../../mailer/src/message";
import type { Bindings } from "./env";

/**
 * The `email-bulk-dlq` consumer (ARCHITECTURE, Wait list: The launch send). A launch email that
 * both providers refused comes here after the mailer's retries. Clearing its address's
 * `notified_at` lets the launch send queue it again. Every message is acked, so none stays on
 * the dead-letter queue. A body that isn't a launch email can name no address to clear.
 *
 * Logs carry counts only: a dead-lettered body is an address and a link.
 */
export async function deadLetteredLaunchEmails(
  batch: MessageBatch<unknown>,
  env: Pick<Bindings, "HYPERDRIVE">,
  ctx: ExecutionContext,
): Promise<void> {
  const addresses = new Set<string>();
  let unusable = 0;
  for (const message of batch.messages) {
    const parsed = parseMessage(message.body);
    if (parsed?.kind === "waitlist-launch") addresses.add(parsed.to);
    else unusable++;
  }

  const event = "waitlist.launch-dead-letter";
  if (addresses.size === 0) {
    batch.ackAll();
    console.warn({ event, outcome: "no launch email", messages: batch.messages.length });
    return;
  }

  const db = createDb({ connectionString: env.HYPERDRIVE.connectionString });
  try {
    const result = await db
      .updateTable("waitlist")
      .set({ notified_at: null })
      .where("email", "in", [...addresses])
      .executeTakeFirst();
    batch.ackAll();
    console.log({
      event,
      outcome: "cleared",
      messages: batch.messages.length,
      unusable,
      cleared: Number(result.numUpdatedRows),
    });
  } catch (error) {
    // The error's name only: Postgres can quote the row it failed on. Retried as a batch
    // under this consumer's own max_retries.
    const kind = error instanceof Error ? error.name : "unknown";
    console.error({ event, outcome: "failed", error: kind });
    batch.retryAll();
  } finally {
    ctx.waitUntil(db.destroy());
  }
}
