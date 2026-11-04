import { deliver } from "./deliver";
import { parseMessage } from "./message";
import { pace, bulkIntervalMs } from "./pace";
import { acceptedOn, BULK_QUEUE } from "./queues";
import { render } from "./render";
import { resendSender } from "./resend";
import type { OutgoingEmail } from "./sender";

export interface Env {
  RESEND_API_KEY: string;
  MAIL_FROM: string;
  /** Seconds between email-bulk batches (wrangler.jsonc vars). */
  BULK_INTERVAL_SECONDS?: string;
}

export default {
  async queue(batch, env, _ctx) {
    const valid: Message[] = [];
    const emails: OutgoingEmail[] = [];
    for (const message of batch.messages) {
      const parsed = acceptedOn(batch.queue, parseMessage(message.body));
      if (parsed === null) {
        message.ack();
        continue;
      }
      valid.push(message);
      emails.push(render(parsed, env.MAIL_FROM));
    }

    // Logs carry provider message IDs, outcomes and counts only: never an address, a link,
    // a message body, a provider's response body or an error's text (ARCHITECTURE, Auth, Email).
    const invalid = batch.messages.length - valid.length;
    if (invalid > 0) console.warn({ event: "email.invalid", count: invalid });
    if (emails.length === 0) return;

    const startedAt = Date.now();
    // Only Resend for now: the failover provider is still to be chosen.
    const { sender, result } = await deliver(emails, [resendSender(env.RESEND_API_KEY)]);
    const line = { event: "email.send", provider: sender, count: emails.length };
    if (result.outcome === "sent") {
      console.log({ ...line, outcome: "sent", ids: result.ids });
      // A refused email is acked with the rest: retrying a bad address would only fail again.
      const rejected = result.rejected?.length ?? 0;
      if (rejected > 0) console.warn({ event: "email.refused", provider: sender, count: rejected });
    } else console.error({ ...line, outcome: result.outcome, status: result.status });

    // Ack and retry per message: a retried message is dead-lettered after max_retries.
    for (const message of valid) {
      if (result.outcome === "sent") message.ack();
      else message.retry();
    }

    // email-bulk only: hold the invocation until the interval has passed, so the next batch
    // starts no sooner. A wait on that queue never holds up `email`, a consumer of its own.
    if (batch.queue === BULK_QUEUE) {
      await pace(
        startedAt,
        bulkIntervalMs(env.BULK_INTERVAL_SECONDS),
        Date.now,
        (ms) => new Promise((done) => setTimeout(done, ms)),
      );
    }
  },
} satisfies ExportedHandler<Env>;
