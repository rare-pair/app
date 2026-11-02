// Removing a work everywhere (ARCHITECTURE, "Removal really removes"): its status, its
// files in R2 and every cached copy at the edge, in that order. A moderator's remove calls
// it, and the takedown and author paths will too.
import { removeWork, type Database } from "@archive/db";
import type { Kysely } from "kysely";
import type { PurgeTarget } from "./purge";
import { deleteWorkObjects, type ObjectBucket } from "./remove-objects";

export interface RemoveDeps {
  db: Kysely<Database>;
  bucket: ObjectBucket;
  /** Purges the work from Cloudflare's cache: `purgeWorkCaches` with the Worker's credentials. */
  purge: (target: PurgeTarget) => Promise<void>;
}

/**
 * `processing` when an ingest job is still saving the work, so nothing changed. Otherwise
 * the work is removed (now, or before) and its files are deleted, and `caches` says
 * whether the purge was accepted.
 */
export type RemoveResult =
  | { outcome: "processing" }
  | { outcome: "removed" | "already_removed"; caches: "purged" | "failed" };

/**
 * Removes the work. The status and the log row commit first, then R2: a delete that fails
 * partway leaves a removed work with leftover bytes, never a live one with missing bytes.
 * The purge comes last, once the bytes are gone, so no read can fill the cache again from
 * R2. A delete that throws skips the purge and throws. Every step is safe to repeat, so a
 * repeat remove retries whichever failed. Null when there is no such work.
 */
export async function removeWorkEverywhere(
  deps: RemoveDeps,
  workId: string,
  actor: string,
): Promise<RemoveResult | null> {
  const removed = await removeWork(deps.db, workId, actor);
  if (!removed) return null;
  if (removed.outcome === "processing") return { outcome: "processing" };
  await deleteWorkObjects(deps.bucket, removed.ao3WorkId, removed.uploads);
  try {
    await deps.purge({
      ao3WorkId: removed.ao3WorkId,
      uploadIds: removed.uploads.map((u) => u.id),
    });
  } catch (error) {
    // The step and the error's name only: never the work, its keys or Cloudflare's reply.
    console.error(
      "remove work: cache purge failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return { outcome: removed.outcome, caches: "failed" };
  }
  return { outcome: removed.outcome, caches: "purged" };
}
