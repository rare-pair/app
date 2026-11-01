import { createDb } from "@archive/db";
import { errorCode, LIMITS, sweep, type Limits } from "./sweep";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  BUCKET: R2Bucket;
}

/** How old an object must be before the sweep deletes it (operator ruling on #73). */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** The scheduled handler, with `limits` on what one run may spend. */
export function sweepWorker(limits: Limits = LIMITS) {
  return {
    async scheduled(controller, env) {
      // Logs carry counts, AO3 work IDs and error class names only: never stored text.
      const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
      try {
        // The cron's own time, not the clock: a late or retried run judges age the same way.
        const cutoff = new Date(controller.scheduledTime - MIN_AGE_MS);
        const report = await sweep({ db, bucket: env.BUCKET, cutoff, limits });
        console.log({ event: "sweep.run", ...report });
      } catch (error) {
        console.error({ event: "sweep.run", error: errorCode(error) });
        throw error;
      } finally {
        await db.destroy();
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default sweepWorker();
