import type { Kysely, Transaction } from "kysely";
import type { Database } from "./schema";

/** The actions a moderator takes (ARCHITECTURE, Moderation). Free text in the table, so a new one needs no migration. */
export type ModerationAction =
  | "hide"
  | "restore"
  | "reject"
  | "remove"
  | "approve"
  | "make_current"
  | "ban"
  | "block";

export type ModerationTargetKind = "work" | "request" | "takedown" | "report" | "version" | "user";

export interface ModerationEntry {
  /** The `user.id` of the acting moderator or admin. */
  moderatorId: string;
  action: ModerationAction;
  targetKind: ModerationTargetKind;
  /** The target row's own id (a work's `id`, not its AO3 work ID). */
  targetId: string;
  /** Short. Never reader data or a requester's email. */
  note?: string;
}

const NOTE_MAX = 200;

/**
 * Inserts one row of the action log. Pass the transaction the action ran in and
 * call it only after the action changed a row: it never opens a transaction of
 * its own, so a row can't outlive an action that rolled back. The database sets
 * the id and the time.
 */
export async function logModerationAction(
  db: Kysely<Database>,
  entry: ModerationEntry,
): Promise<void> {
  const { note } = entry;
  if (note !== undefined && (!/\S/.test(note) || note.length > NOTE_MAX)) {
    throw new RangeError(`A moderation note is 1 to ${NOTE_MAX} characters, not blank.`);
  }
  await db
    .insertInto("moderation_actions")
    .values({
      moderator_id: entry.moderatorId,
      action: entry.action,
      target_kind: entry.targetKind,
      target_id: entry.targetId,
      note: note ?? null,
    })
    .execute();
}

/** Runs `fn` in the caller's transaction when it passed one, else opens one. */
export async function inTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (!db.isTransaction) return db.transaction().execute(fn);
  // SAFETY: Kysely sets isTransaction only on a Transaction instance.
  const trx = db as Transaction<Database>;
  return fn(trx);
}
