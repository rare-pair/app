import type { Database, UploadStatus } from "@archive/db";
import type { EpubErrorCode } from "@archive/epub";
import { sql, type ExpressionBuilder, type Kysely } from "kysely";
import { LEASE_RENEW_SECONDS, LEASE_SECONDS } from "./config";

/** How long a job holds its upload, and how often it renews that; tests shorten both. */
export interface LeaseTiming {
  seconds: number;
  renewSeconds: number;
}

export const LEASE_TIMING: LeaseTiming = {
  seconds: LEASE_SECONDS,
  renewSeconds: LEASE_RENEW_SECONDS,
};

/** The job no longer holds its upload: another job has taken it over, and owns the row. */
export class LeaseLost extends Error {}

/** A claimed upload: what the job needs to read it, and its lease. */
export interface Lease {
  id: string;
  r2Key: string;
  /**
   * When the lease ends. Also the lease's token: each claim and each renewal sets a new one,
   * and the keeper updates this to match. The ending writes compare against it.
   */
  until: Date;
  /**
   * SHA-256 (lowercase hex) of the file this job read. The ending writes record it, over the hash
   * confirm stored; absent until the job has read one, and then they leave that hash alone.
   */
  sha256?: string;
  /** Renews the lease while the job runs; absent for a lease nobody keeps (a test's). */
  keeper?: LeaseKeeper;
}

/** An upload no job holds and none has ended: `pending`, or its lease has expired. */
export const claimable = (eb: ExpressionBuilder<Database, "uploads">) =>
  eb.or([
    eb("status", "=", "pending"),
    eb.and([eb("status", "=", "processing"), eb("lease_until", "<", sql<Date>`now()`)]),
  ]);

/**
 * Claims the upload for one job, with one atomic `UPDATE` that matches only when it is
 * `pending` or its lease has expired (ARCHITECTURE, EPUB processor, step 1). The database's
 * clock decides, so two consumers agree on it. Null when another job holds the upload, or it
 * is past processing.
 */
export async function claimLease(
  db: Kysely<Database>,
  uploadId: string,
  seconds: number = LEASE_SECONDS,
): Promise<Lease | null> {
  const row = await db
    .updateTable("uploads")
    .set({
      status: "processing",
      // To the millisecond, so the token survives the trip through a JavaScript Date.
      lease_until: sql<Date>`date_trunc('milliseconds', now() + make_interval(secs => ${seconds}))`,
    })
    .where("id", "=", uploadId)
    .where(claimable)
    .returning(["id", "r2_key", "lease_until"])
    .executeTakeFirst();
  // SAFETY: the update above sets lease_until on the row it returns.
  return row ? { id: row.id, r2Key: row.r2_key, until: row.lease_until as Date } : null;
}

/** Where a job was when it stopped, as `uploads.error_stage` records it. */
export type Stage = "read" | "process" | "save";

/** How a job ends for its upload: back to `pending` for a retry, or a rejection code. */
export interface Outcome {
  status:
    | "pending"
    | Extract<UploadStatus, EpubErrorCode | "opted_out" | "work_removed" | "account_banned">;
  /** The stage that failed, and a short fixed code for what happened. */
  failure?: { stage: Stage; error: string };
}

/**
 * Records the outcome and ends the lease, only while this job still holds it: a job that
 * outlived its lease leaves the row to the job that took it over. Says whether it matched: only
 * then was the upload still this job's, and, ended with a final status, it is nobody's to claim.
 */
export async function endLease(
  db: Kysely<Database>,
  lease: Lease,
  outcome: Outcome,
): Promise<boolean> {
  const row = await db
    .updateTable("uploads")
    .set({
      status: outcome.status,
      lease_until: null,
      error_stage: outcome.failure?.stage ?? null,
      error: outcome.failure?.error ?? null,
      sha256: lease.sha256,
    })
    .where("id", "=", lease.id)
    .where("status", "=", "processing")
    .where("lease_until", "=", lease.until)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Renews the lease with one fenced `UPDATE`: it matches only while the upload is still
 * `processing` under this lease's token, so a job that lost the lease cannot take it back.
 * Moves `lease.until` to the new token and returns true, or returns false when nothing matched.
 */
async function renewLease(db: Kysely<Database>, lease: Lease, seconds: number): Promise<boolean> {
  const row = await db
    .updateTable("uploads")
    .set({
      lease_until: sql<Date>`date_trunc('milliseconds', now() + make_interval(secs => ${seconds}))`,
    })
    .where("id", "=", lease.id)
    .where("status", "=", "processing")
    .where("lease_until", "=", lease.until)
    .returning("lease_until")
    .executeTakeFirst();
  if (row === undefined) return false;
  // SAFETY: the update above sets lease_until on the row it returns.
  lease.until = row.lease_until as Date;
  return true;
}

/**
 * Keeps a claimed lease while the job runs (ARCHITECTURE, EPUB processor, step 1): a timer
 * renews it every `renewSeconds`, and the job calls `check` before each write and `renew` at
 * each stage. A renewal that matches nothing means another job took the upload over: the
 * keeper remembers it, and every later `check` and `renew` throws `LeaseLost`.
 *
 * One renewal runs at a time, and `stop` waits for it: a renewal that landed between reading
 * `lease.until` and an ending write would change the token under that write, which would then
 * match nothing and leave the upload `processing` until it expired.
 */
export class LeaseKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing: Promise<void> | null = null;
  private lost = false;
  /** A renewal failed with the database unreachable: the token may have moved unseen. */
  private unsure = false;
  private renewedAt = Date.now();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly lease: Lease,
    private readonly timing: LeaseTiming,
  ) {}

  /** Renews on a timer. A failed renewal is left for the next tick or the next `renew`. */
  start(): void {
    this.timer = setInterval(() => {
      this.renew().catch(() => undefined);
    }, this.timing.renewSeconds * 1000);
  }

  /** Stops the timer and waits for a renewal in flight. The keeper still answers `renew`. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.renewing?.catch(() => undefined);
  }

  /** Renews now, or throws `LeaseLost`. */
  async renew(): Promise<void> {
    this.renewing ??= this.renewOnce().finally(() => (this.renewing = null));
    await this.renewing;
    if (this.lost) throw new LeaseLost();
  }

  /**
   * Before a write: throws `LeaseLost` when the lease is lost, and renews first when the timer
   * has not for an interval (a long synchronous step blocks timers).
   */
  async check(): Promise<void> {
    if (this.lost) throw new LeaseLost();
    if (Date.now() - this.renewedAt >= this.timing.renewSeconds * 1000) await this.renew();
  }

  private async renewOnce(): Promise<void> {
    if (this.lost) return;
    let renewed: boolean;
    try {
      renewed = await renewLease(this.db, this.lease, this.timing.seconds);
    } catch (error) {
      // The update may have committed with its answer lost: the token is then unknown.
      this.unsure = true;
      throw error;
    }
    if (renewed) {
      this.renewedAt = Date.now();
      this.unsure = false;
    } else if (this.unsure) {
      // Not proof of a takeover: a plain failure, so the message is retried, not dropped.
      throw new Error("lease renewal outcome unknown");
    } else {
      this.lost = true;
      if (this.timer !== null) clearInterval(this.timer);
    }
  }
}
