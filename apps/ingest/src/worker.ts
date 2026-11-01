import { createDb, type Database } from "@archive/db";
import { processEpub } from "@archive/epub";
import type { Kysely } from "kysely";
import { errorCode, runJob, type JobDeps, type Verdict } from "./job";
import { parseMessage } from "./message";
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
export type Steps = Pick<JobDeps, "process" | "save"> & {
  bucket: (real: R2Bucket) => JobBucket;
};

/** Where the content Worker serves a work's images from. */
const CONTENT_ORIGIN = "https://content.rarepair.fans";

/**
 * The processor, with each image's `src` pointed at the content origin under the work's `img`
 * prefix, and the images it accepts added to `images`, to be written by the save.
 */
const processForStorage: JobDeps["process"] = (bytes, images) =>
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
      let db: Kysely<Database>;
      try {
        // One job at a time needs one connection.
        db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
      } catch (error) {
        console.error({ event: "ingest.setup", error: errorCode(error) });
        batch.retryAll();
        return;
      }
      const bucket = steps.bucket ? steps.bucket(env.BUCKET) : env.BUCKET;
      const deps: JobDeps = {
        db,
        bucket,
        process: steps.process ?? processForStorage,
        save:
          steps.save ??
          ((lease, work, bytes, images) => saveWork({ db, bucket }, lease, work, bytes, images)),
      };
      let invalid = 0;
      try {
        // One job at a time: an invocation holds one epub and its parse in memory, not five.
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

export default ingestWorker();
