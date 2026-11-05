import { createDb, type Database } from "@archive/db";
import { processEpub } from "@archive/epub";
import type { Kysely } from "kysely";
import { runBackfill, type BackfillDeps } from "./backfill";
import { BACKFILL_QUEUE, INGEST_DLQ, INGEST_QUEUE } from "./config";
import { DEAD_LETTER_DB_TIMEOUTS, deadLetterBatch } from "./dead-letter";
import { errorCode, runJob, type JobDeps, type Verdict } from "./job";
import { parseBackfillMessage, parseMessage } from "./message";
import { saveWork, type SaveBucket } from "./save";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  BUCKET: R2Bucket;
}

/** What the job and the save use of the bucket. */
type JobBucket = JobDeps["bucket"] & SaveBucket;

/**
 * The job's steps a test may replace, to fail one stage or to watch it. `bucket` wraps the
 * real bucket, to fail or watch a write.
 */
export type Steps = Pick<JobDeps, "process" | "save" | "timing"> & {
  bucket: (real: R2Bucket) => JobBucket;
};

/** Where the content Worker serves a work's images from. */
const CONTENT_ORIGIN = "https://content.rarepair.fans";

/**
 * The processor, with each image's `src` pointed at the content origin under the work's `img`
 * prefix, and the images it accepts added to `images`, to be written by the save.
 */
export const processForStorage: JobDeps["process"] = (bytes, images) =>
  processEpub(bytes, {
    imageBase: (ao3WorkId) => `${CONTENT_ORIGIN}/works/${ao3WorkId}/img/`,
    onImage: (ref, data) => void images?.set(ref.key, { mediaType: ref.mediaType, bytes: data }),
  });

/** The queue handler, with `steps` over the real ones. */
export function ingestWorker(steps: Partial<Steps> = {}) {
  return {
    async queue(batch, env, ctx) {
      // Logs carry upload ids, verdicts, counts and error class names only: never an error's
      // message or other text from an uploaded file.
      if (
        batch.queue !== INGEST_QUEUE &&
        batch.queue !== INGEST_DLQ &&
        batch.queue !== BACKFILL_QUEUE
      ) {
        // A queue bound by mistake: its messages wait, then dead-letter, rather than being
        // read as the wrong contract and acked as invalid.
        console.error({ event: "ingest.unknown_queue", count: batch.messages.length });
        batch.retryAll();
        return;
      }
      let db: Kysely<Database>;
      try {
        // One job at a time needs one connection.
        db = createDb({
          connectionString: env.HYPERDRIVE.connectionString,
          max: 1,
          ...(batch.queue === INGEST_DLQ ? DEAD_LETTER_DB_TIMEOUTS : {}),
        });
      } catch (error) {
        console.error({ event: "ingest.setup", error: errorCode(error) });
        batch.retryAll();
        return;
      }
      if (batch.queue === INGEST_DLQ) {
        try {
          await deadLetterBatch(batch, db);
        } finally {
          ctx.waitUntil(db.destroy());
        }
        return;
      }
      const bucket = steps.bucket ? steps.bucket(env.BUCKET) : env.BUCKET;
      const deps: JobDeps = {
        db,
        bucket,
        process: steps.process ?? processForStorage,
        timing: steps.timing,
        save:
          steps.save ??
          ((lease, work, bytes, images) => saveWork({ db, bucket }, lease, work, bytes, images)),
      };
      if (batch.queue === BACKFILL_QUEUE) {
        try {
          await backfillBatch(batch, { db, bucket, process: deps.process });
        } finally {
          ctx.waitUntil(db.destroy());
        }
        return;
      }
      let invalid = 0;
      try {
        // A batch is one job (wrangler.jsonc): an invocation holds one epub and its parse in memory.
        for (const message of batch.messages) {
          const parsed = parseMessage(message.body);
          if (parsed === null) {
            invalid++;
            message.ack();
            continue;
          }
          const uploadId = parsed.upload_id;
          const line = { event: "ingest.job", uploadId, attempt: message.attempts };
          // Caught per message: a throw out of queue() would retry the whole batch.
          let verdict: Verdict = "retry";
          try {
            verdict = await runJob(deps, uploadId, message.attempts);
            console.log({ ...line, verdict });
          } catch (error) {
            // Postgres down while claiming or recording: the queue tries again later.
            console.error({ ...line, verdict, error: errorCode(error) });
          }
          if (verdict === "ack") message.ack();
          else message.retry();
        }
        if (invalid > 0) console.warn({ event: "ingest.invalid", count: invalid });
      } finally {
        ctx.waitUntil(db.destroy());
      }
    },
  } satisfies ExportedHandler<Env>;
}

/**
 * Runs each backfill message's job, one after another. Logs carry work and version ids,
 * outcomes and error class names only. A final outcome is acked; a failure worth retrying is
 * retried, and dead-lettered once the queue's retries are spent, leaving the work as it was.
 */
async function backfillBatch(batch: MessageBatch, deps: BackfillDeps): Promise<void> {
  let invalid = 0;
  for (const message of batch.messages) {
    const parsed = parseBackfillMessage(message.body);
    if (parsed === null) {
      invalid++;
      message.ack();
      continue;
    }
    const line = {
      event: "ingest.backfill",
      workId: parsed.work_id,
      versionId: parsed.version_id,
      attempt: message.attempts,
    };
    // Caught per message: a throw out of queue() would retry the whole batch.
    try {
      const outcome = await runBackfill(deps, parsed);
      console.log({ ...line, outcome });
      message.ack();
    } catch (error) {
      console.error({ ...line, outcome: "retry", error: errorCode(error) });
      message.retry();
    }
  }
  if (invalid > 0) console.warn({ event: "ingest.backfill_invalid", count: invalid });
}

export default ingestWorker();
