import { sql, type Kysely } from "kysely";
import { inTransaction, logModerationAction } from "./moderation-actions";
import type { Database } from "./schema";

/** What a ban did: it banned the account, or why it changed nothing. */
export type BanResult = "banned" | "already_banned" | "protected" | "not_found";

/** The roles with moderator powers: no moderator bans one (orchestrator ruling, MOD6). */
const PROTECTED_ROLES = new Set(["moderator", "admin"]);

/**
 * Bans an uploader's account (ARCHITECTURE, Moderation): sets `banned_at`, ends the account's
 * `pending` uploads as `account_banned`, and logs the ban with `actor`, the acting moderator's
 * user id, all in one transaction, or in the caller's when `db` is one. Live works, versions
 * and finished uploads stay as they are; a `processing` upload is ingest's, which refuses it.
 * An account already banned keeps its first `banned_at` and writes nothing. The acting
 * moderator, another moderator and an admin can't be banned (`protected`).
 */
export async function banUser(
  db: Kysely<Database>,
  userId: string,
  options: { actor: string },
): Promise<BanResult> {
  return inTransaction(db, async (trx) => {
    // Locked to the end of the transaction, so a second ban or a role change waits for this one.
    const user = await trx
      .selectFrom("user")
      .select(["role", "banned_at"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (user === undefined) return "not_found";
    if (userId === options.actor || (user.role !== null && PROTECTED_ROLES.has(user.role))) {
      return "protected";
    }
    if (user.banned_at !== null) return "already_banned";
    await trx
      .updateTable("user")
      .set({ banned_at: sql<Date>`now()` })
      .where("id", "=", userId)
      .execute();
    await trx
      .updateTable("uploads")
      .set({ status: "account_banned" })
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .execute();
    await logModerationAction(trx, {
      moderatorId: options.actor,
      action: "ban",
      targetKind: "user",
      targetId: userId,
    });
    return "banned";
  });
}

/**
 * Whether the account is banned. Read from the database on every request, never from a
 * session: the session's user has no `banned_at`, and a ban must hold at once. An account with
 * no row counts as banned, so it can't upload or report either.
 */
export async function isBanned(db: Kysely<Database>, userId: string): Promise<boolean> {
  const user = await db
    .selectFrom("user")
    .select("banned_at")
    .where("id", "=", userId)
    .executeTakeFirst();
  return user === undefined || user.banned_at !== null;
}

/**
 * Whether the account that made upload `uploadId` is banned, as `isBanned` decides. With
 * `lock`, inside a transaction, the account's row stays locked shared to its end, so a ban
 * (`banUser` locks the row for update) either commits first and is seen here, or waits for
 * the transaction to commit.
 */
export async function isUploaderBanned(
  db: Kysely<Database>,
  uploadId: string,
  { lock = false }: { lock?: boolean } = {},
): Promise<boolean> {
  let query = db
    .selectFrom("user")
    .select("banned_at")
    .where("id", "=", (eb) =>
      eb.selectFrom("uploads").select("uploads.user_id").where("uploads.id", "=", uploadId),
    );
  if (lock) query = query.forShare();
  const user = await query.executeTakeFirst();
  return user === undefined || user.banned_at !== null;
}
