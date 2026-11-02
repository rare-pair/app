// A moderator's approval of a version on Works to check, and the close of a work's
// "This version is wrong" reports (ARCHITECTURE, Moderation).

import { sql, type Kysely } from "kysely";
import { inTransaction, logModerationAction } from "./moderation-actions";
import { closeOpenWrongVersionReports, makeVersionCurrent } from "./queries";
import type { Database } from "./schema";

/**
 * What `approveVersion` did: `cleared` the notice of the work's current version,
 * `published` a held version, changed `nothing` (nothing to approve, or a version that
 * isn't the work's), or found the work `unavailable` (removed, or ingest is still
 * finishing it).
 */
export type ApproveOutcome = "cleared" | "published" | "nothing" | "unavailable";

/**
 * Approves one of a work's versions, in one transaction. A held version is published: its
 * upload goes `live`, it is marked checked, and the work then describes it
 * (`makeVersionCurrent`, which closes the work's open `wrong_version` reports as the pointer
 * moves). The current version of a live or hidden work whose review reasons nobody has
 * cleared gets `checked_at`, which ends the notice. Any other version is left alone.
 * `hold_reason` is kept after a publish: the upload's status is the state.
 *
 * The work's row is locked first (for no key update, the lock ingest's compare-and-swap
 * takes), so an ingest can't move the pointer between the check and the write. With `actor`,
 * the acting moderator's user id, it logs one `approve` on the version when it changed
 * something. It runs in the caller's transaction when `db` is one.
 */
export async function approveVersion(
  db: Kysely<Database>,
  workId: string,
  versionId: string,
  options: { actor?: string } = {},
): Promise<ApproveOutcome> {
  return inTransaction(db, async (trx) => {
    const work = await trx
      .selectFrom("works")
      .select("current_version_id")
      .where("id", "=", workId)
      .where("status", "in", ["live", "hidden"])
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (work === undefined) return "unavailable";
    const version = await trx
      .selectFrom("work_versions")
      .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
      .select(["work_versions.upload_id", "uploads.status as upload_status"])
      .where("work_versions.id", "=", versionId)
      .where("work_versions.work_id", "=", workId)
      .executeTakeFirst();
    if (version === undefined) return "nothing";

    let outcome: ApproveOutcome;
    if (version.upload_status === "held_for_review") {
      const published = await trx
        .updateTable("uploads")
        .set({ status: "live" })
        .where("id", "=", version.upload_id)
        .where("status", "=", "held_for_review")
        .executeTakeFirst();
      if (published.numUpdatedRows === 0n) return "nothing";
      // Checked, or a held version with review reasons would keep the work on Works to check.
      await trx
        .updateTable("work_versions")
        .set({ checked_at: sql<Date>`coalesce(checked_at, now())` })
        .where("id", "=", versionId)
        .execute();
      // No `actor`: the approve is the one log row.
      if (!(await makeVersionCurrent(trx, workId, versionId))) {
        throw new Error("The work was locked as live or hidden, so the version must be current.");
      }
      outcome = "published";
    } else if (version.upload_status === "live" && work.current_version_id === versionId) {
      const cleared = await trx
        .updateTable("work_versions")
        .set({ checked_at: sql<Date>`now()` })
        .where("id", "=", versionId)
        .where("checked_at", "is", null)
        .where(sql<boolean>`cardinality(review_reasons) > 0`)
        .executeTakeFirst();
      if (cleared.numUpdatedRows === 0n) return "nothing";
      outcome = "cleared";
    } else {
      return "nothing";
    }
    if (options.actor !== undefined) {
      await logModerationAction(trx, {
        moderatorId: options.actor,
        action: "approve",
        targetKind: "version",
        targetId: versionId,
      });
    }
    return outcome;
  });
}

/**
 * Closes the work's open `wrong_version` reports ("This version is wrong") in one
 * statement, and returns how many it closed. Other kinds stay open. With `actor`, the acting
 * moderator's user id, it logs one `reject` on the work when any closed (one action closes
 * many rows, so the target is the work). It runs in the caller's transaction when `db` is one.
 */
export async function closeWrongVersionReports(
  db: Kysely<Database>,
  workId: string,
  options: { actor?: string } = {},
): Promise<number> {
  return inTransaction(db, async (trx) => {
    // Like the other actions, not on a removed work (or one that doesn't exist).
    const work = await trx
      .selectFrom("works")
      .select("id")
      .where("id", "=", workId)
      .where("status", "<>", "removed")
      // The lock the other actions take, so a remove can't land between this check and the close.
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (work === undefined) return 0;
    const count = await closeOpenWrongVersionReports(trx, workId);
    if (count > 0 && options.actor !== undefined) {
      await logModerationAction(trx, {
        moderatorId: options.actor,
        action: "reject",
        targetKind: "work",
        targetId: workId,
        note: "wrong_version reports",
      });
    }
    return count;
  });
}
