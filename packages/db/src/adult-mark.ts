// A moderator's adult mark on a work (ARCHITECTURE, Reading, Warnings screen): the work gets
// the warnings screen whatever its rating says. The mark is on `works`, so a new version or a
// rollback (`copyVersionToWork`) leaves it alone.

import type { Kysely, Transaction } from "kysely";
import { inTransaction, logModerationAction } from "./moderation-actions";
import type { Database } from "./schema";

export type AdultMarkOutcome =
  /** The mark is now as asked, and was not before. */
  | "changed"
  /** It was as asked already: nothing changed, nothing logged. */
  | "unchanged"
  /** The work is removed, or there is none. */
  | "unavailable";

export interface MarkAdultResult {
  outcome: AdultMarkOutcome;
  /** How many open `higher_rating` reports it closed. */
  closed: number;
}

/** The work's mark, row-locked as the other actions lock it, or undefined for a removed or missing work. */
const lockedMark = (trx: Transaction<Database>, workId: string) =>
  trx
    .selectFrom("works")
    .select("adult_marked")
    .where("id", "=", workId)
    .where("status", "<>", "removed")
    .forNoKeyUpdate()
    .executeTakeFirst();

/**
 * Marks a work as adult and closes its open `higher_rating` reports ("This needs a higher
 * rating"), in one transaction (the caller's when `db` is one). Logs one `mark_adult` on the
 * work, with `actor`, when it changed the mark or closed a report: none for a repeat that
 * changed nothing. A removed work is left as it is.
 */
export async function markAdult(
  db: Kysely<Database>,
  workId: string,
  options: { actor?: string } = {},
): Promise<MarkAdultResult> {
  return inTransaction(db, async (trx) => {
    const work = await lockedMark(trx, workId);
    if (work === undefined) return { outcome: "unavailable", closed: 0 };
    if (!work.adult_marked) {
      await trx.updateTable("works").set({ adult_marked: true }).where("id", "=", workId).execute();
    }
    const reports = await trx
      .updateTable("reports")
      .set({ status: "closed" })
      .where("work_id", "=", workId)
      .where("kind", "=", "higher_rating")
      .where("status", "=", "open")
      .executeTakeFirst();
    const closed = Number(reports.numUpdatedRows);
    const outcome = work.adult_marked ? "unchanged" : "changed";
    if ((outcome === "changed" || closed > 0) && options.actor !== undefined) {
      await logModerationAction(trx, {
        moderatorId: options.actor,
        action: "mark_adult",
        targetKind: "work",
        targetId: workId,
        ...(closed > 0 && {
          note: `${closed} higher_rating ${closed === 1 ? "report" : "reports"} closed`,
        }),
      });
    }
    return { outcome, closed };
  });
}

/**
 * Lifts the adult mark. Logs one `unmark_adult` on the work, with `actor`, when it was marked:
 * none when it wasn't. A removed work is left as it is.
 */
export async function unmarkAdult(
  db: Kysely<Database>,
  workId: string,
  options: { actor?: string } = {},
): Promise<AdultMarkOutcome> {
  return inTransaction(db, async (trx) => {
    const work = await lockedMark(trx, workId);
    if (work === undefined) return "unavailable";
    if (!work.adult_marked) return "unchanged";
    await trx.updateTable("works").set({ adult_marked: false }).where("id", "=", workId).execute();
    if (options.actor !== undefined) {
      await logModerationAction(trx, {
        moderatorId: options.actor,
        action: "unmark_adult",
        targetKind: "work",
        targetId: workId,
      });
    }
    return "changed";
  });
}
