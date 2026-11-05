import { createDb } from "@archive/db";
import { errorCode, LIMITS, reapUnconfirmedUploads, sweep, type Limits } from "./sweep";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  BUCKET: R2Bucket;
  /** Whole days an upload may stay unconfirmed before the reaper removes it. */
  UNCONFIRMED_UPLOAD_DAYS?: string;
}

/** How old an object must be before the sweep deletes it (operator ruling on #73). */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old an unconfirmed upload must be before it is removed: the var's whole days, or one when
 * it is missing or misspelt. A bad var never takes a link still in use, nor turns this off.
 */
function unconfirmedMaxAgeMs(env: Env): number {
  const days = /^[1-9]\d{0,2}$/.test(env.UNCONFIRMED_UPLOAD_DAYS ?? "")
    ? Number(env.UNCONFIRMED_UPLOAD_DAYS)
    : 1;
  return days * DAY_MS;
}

/** The scheduled handler, with `limits` on what one run may spend. */
export function sweepWorker(limits: Limits = LIMITS) {
  return {
    async scheduled(controller, env) {
      // Logs carry counts, AO3 work IDs and error class names only: never stored text.
      const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
      try {
        // The cron's own time, not the clock: a late or retried run judges age the same way.
        const cutoff = new Date(controller.scheduledTime - MIN_AGE_MS);
        const reaped = await reapUnconfirmedUploads({
          db,
          bucket: env.BUCKET,
          cutoff: new Date(controller.scheduledTime - unconfirmedMaxAgeMs(env)),
        });
        const report = await sweep({ db, bucket: env.BUCKET, cutoff, limits });
        console.log({ event: "sweep.run", ...reaped, ...report });
      } catch (error) {
        const code = errorCode(error);
        console.error({ event: "sweep.run", error: code });
        // The run still fails, but with the class name only: the runtime logs an uncaught
        // error's message, which may quote a query or stored text.
        throw new Error(code);
      } finally {
        try {
          await db.destroy();
        } catch (error) {
          console.error({ event: "sweep.close", error: errorCode(error) });
        }
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default sweepWorker();
