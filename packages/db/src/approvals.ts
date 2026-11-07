// A moderator's approval of a version on Works to check, and the close of a work's
// "This version is wrong" reports (ARCHITECTURE, Moderation).

import { sql, type Kysely } from "kysely";
import { inTransaction, logModerationAction } from "./moderation-actions";
import { closeOpenWrongVersionReports, makeVersionCurrent } from "./queries";
import { checkedNames } from "./pseud";
import type { Database } from "./schema";
import { copyVersionToWork } from "./version-copy";

/**
 * What `approveVersion` did: `cleared` the notice of the work's current version,
 * `published` a held version, changed `nothing` (nothing to approve, or a version that
 * isn't the work's), found the work `unavailable` (removed, or ingest is still
 * finishing it), or kept a held version held because its byline is `opted_out`.
 */
export type ApproveOutcome = "cleared" | "published" | "nothing" | "unavailable" | "opted_out";

/**
 * Approves one of a work's versions, in one transaction. A held version is published: its
 * upload goes `live`, it is marked checked, and the work then describes it
 * (`makeVersionCurrent`, which closes the work's open `wrong_version` reports as the pointer
 * moves). A held version whose byline names an active opt-out, by a pseud or a login, isn't
 * published: it stays held, `opted_out`, since the list may have changed while it waited. A
 * `held` work (spec 12: its first upload a PDF whose byline the reader wasn't sure of) goes
 * `live` at the version approved. The current version of a live or hidden work whose review
 * reasons nobody has
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
      .select(["status", "current_version_id"])
      .where("id", "=", workId)
      .where("status", "in", ["live", "hidden", "held"])
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (work === undefined) return "unavailable";
    const version = await trx
      .selectFrom("work_versions")
      // A backfill version (migration 0016) has no upload of its own, so no upload to hold.
      .leftJoin("uploads", "uploads.id", "work_versions.upload_id")
      .select([
        "work_versions.upload_id",
        "uploads.status as upload_status",
        "work_versions.authors",
      ])
      .where("work_versions.id", "=", versionId)
      .where("work_versions.work_id", "=", workId)
      .executeTakeFirst();
    if (version === undefined) return "nothing";

    let outcome: ApproveOutcome;
    if (version.upload_id !== null && version.upload_status === "held_for_review") {
      if (await optedOut(trx, checkedNames(version.authors ?? []))) return "opted_out";
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
      if (work.status === "held") {
        // The work's first time public: at this version, as ingest's first upload goes live.
        await trx
          .updateTable("works")
          .set({ current_version_id: versionId, status: "live" })
          .where("id", "=", workId)
          .execute();
        await copyVersionToWork(trx, workId, versionId);
      } else if (
        // No `actor`: the approve is the one log row.
        !(await makeVersionCurrent(trx, workId, versionId))
      ) {
        throw new Error("The work was locked as live or hidden, so the version must be current.");
      }
      outcome = "published";
    } else if (
      // A backfill version is never held: it re-makes a version that went live.
      (version.upload_id === null || version.upload_status === "live") &&
      work.current_version_id === versionId
    ) {
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

/** Whether any of `names` (`pseud_norm`s) is on the active opt-out list. */
async function optedOut(trx: Kysely<Database>, names: string[]): Promise<boolean> {
  if (names.length === 0) return false;
  const row = await trx
    .selectFrom("optouts")
    .select("id")
    .where("active", "=", true)
    .where(sql<boolean>`pseud_norm = any(${names}::text[])`)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
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

export type DismissOutcome =
  /** It was open, and is now closed. */
  | "dismissed"
  /** It was closed already: nothing changed. */
  | "closed"
  /** No such report, or a `wrong_version` one, which `closeWrongVersionReports` closes. */
  | "missing";

/**
 * Closes one open report a moderator found no merit in, and logs one `dismiss` on it with the
 * moderator's user id. It leaves the work alone, so a hide stays until Restore lifts it, and
 * takes a report on a removed work too, since the Reports queue lists those. It runs in the
 * caller's transaction when `db` is one.
 */
export async function dismissReport(
  db: Kysely<Database>,
  reportId: string,
  options: { actor: string },
): Promise<DismissOutcome> {
  return inTransaction(db, async (trx) => {
    const closed = await trx
      .updateTable("reports")
      .set({ status: "closed" })
      .where("id", "=", reportId)
      .where("status", "=", "open")
      .where("kind", "<>", "wrong_version")
      .executeTakeFirst();
    if (closed.numUpdatedRows === 0n) {
      const report = await trx
        .selectFrom("reports")
        .select("id")
        .where("id", "=", reportId)
        .where("kind", "<>", "wrong_version")
        .executeTakeFirst();
      return report === undefined ? "missing" : "closed";
    }
    await logModerationAction(trx, {
      moderatorId: options.actor,
      action: "dismiss",
      targetKind: "report",
      targetId: reportId,
    });
    return "dismissed";
  });
}
