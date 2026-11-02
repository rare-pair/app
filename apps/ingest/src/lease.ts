import type { Database, UploadStatus } from "@archive/db";
import type { EpubErrorCode } from "@archive/epub";
import { sql, type Kysely } from "kysely";
import { LEASE_SECONDS } from "./config";

/** A claimed upload: what the job needs to read it, and its lease. */
export interface Lease {
  id: string;
  r2Key: string;
  /** When the lease ends. Also the lease's token: each claim sets a new one. */
  until: Date;
}

/**
 * Claims the upload for one job, with one atomic `UPDATE` that matches only when it is
 * `pending` or its lease has expired (ARCHITECTURE, EPUB processor, step 1). The database's
 * clock decides, so two consumers agree on it. Null when another job holds the upload, or it
 * is past processing.
 */
export async function claimLease(db: Kysely<Database>, uploadId: string): Promise<Lease | null> {
  const row = await db
    .updateTable("uploads")
    .set({
      status: "processing",
      // To the millisecond, so the token survives the trip through a JavaScript Date.
      lease_until: sql<Date>`date_trunc('milliseconds', now() + make_interval(secs => ${LEASE_SECONDS}))`,
    })
    .where("id", "=", uploadId)
    .where((eb) =>
      eb.or([
        eb("status", "=", "pending"),
        eb.and([eb("status", "=", "processing"), eb("lease_until", "<", sql<Date>`now()`)]),
      ]),
    )
    .returning(["id", "r2_key", "lease_until"])
    .executeTakeFirst();
  // SAFETY: the update above sets lease_until on the row it returns.
  return row ? { id: row.id, r2Key: row.r2_key, until: row.lease_until as Date } : null;
}

/** Where a job was when it stopped, as `uploads.error_stage` records it. */
export type Stage = "read" | "process" | "save";

/** How a job ends for its upload: back to `pending` for a retry, or a rejection code. */
export interface Outcome {
  status: "pending" | Extract<UploadStatus, EpubErrorCode | "opted_out" | "work_removed">;
  /** The stage that failed, and a short fixed code for what happened. */
  failure?: { stage: Stage; error: string };
}

/**
 * Records the outcome and ends the lease, only while this job still holds it: a job that
 * outlived its lease leaves the row to the job that took it over.
 */
export async function endLease(
  db: Kysely<Database>,
  lease: Lease,
  outcome: Outcome,
): Promise<void> {
  await db
    .updateTable("uploads")
    .set({
      status: outcome.status,
      lease_until: null,
      error_stage: outcome.failure?.stage ?? null,
      error: outcome.failure?.error ?? null,
    })
    .where("id", "=", lease.id)
    .where("status", "=", "processing")
    .where("lease_until", "=", lease.until)
    .execute();
}
