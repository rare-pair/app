import { createDb } from "@archive/db";
import { sweep } from "./sweep";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  BUCKET: R2Bucket;
}

/** How old an object must be before the sweep deletes it (operator ruling on #73). */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** The scheduled handler. */
export function sweepWorker() {
  return {
    async scheduled(controller, env) {
      const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
      try {
        // The cron's own time, not the clock: a late or retried run judges age the same way.
        const cutoff = new Date(controller.scheduledTime - MIN_AGE_MS);
        await sweep({ db, bucket: env.BUCKET, cutoff });
      } finally {
        await db.destroy();
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default sweepWorker();
