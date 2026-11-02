import { sql, type Kysely } from "kysely";
import { inTransaction, logModerationAction } from "./moderation-actions";
import type { Database } from "./schema";

/** What a ban did: it banned the account, or why it changed nothing. */
export type BanResult = "banned" | "already_banned" | "protected" | "not_found";

/** The roles with every moderator power (ARCHITECTURE, Data model): an admin has them too. */
export type ModeratorRole = "moderator" | "admin";

/**
 * Exactly a role with moderator powers: not null, not "user", no other spelling. The /admin
 * gate lets these in, and no moderator bans one (orchestrator ruling, MOD6).
 */
export const isModeratorRole = (role: string | null | undefined): role is ModeratorRole =>
  role === "moderator" || role === "admin";

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
    // The pending uploads first, then the account: the order a confirm takes them in
    // (`countUploadQuota` claims the upload, then counts on the user), so a ban and a confirm
    // by the same uploader wait for each other instead of deadlocking.
    await trx
      .selectFrom("uploads")
      .select("id")
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .forUpdate()
      .execute();
    // Locked to the end of the transaction, so a second ban or a role change waits for this
    // one, and so does a save that checks the ban (`isUploaderBanned` with `lock`).
    const user = await trx
      .selectFrom("user")
      .select(["role", "banned_at"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (user === undefined) return "not_found";
    if (userId === options.actor || isModeratorRole(user.role)) {
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
  return bannedRow(user);
}

/**
 * Ends a banned account's upload as `account_banned`, as the ban ended its other pending ones:
 * for a row written after the ban, by a request that had passed its check just before. Only
 * while it is `pending` and `userId`'s. Its object is left to the `uploads/` expiry.
 */
export async function endBannedUpload(
  db: Kysely<Database>,
  uploadId: string,
  userId: string,
): Promise<void> {
  await db
    .updateTable("uploads")
    .set({ status: "account_banned" })
    .where("id", "=", uploadId)
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .execute();
}

/** The one rule both checks share: a banned account, or none at all. */
const bannedRow = (user: { banned_at: Date | null } | undefined) =>
  user === undefined || user.banned_at !== null;

/**
 * Whether the account that made upload `uploadId` is banned, as `isBanned` decides. With
 * `lock`, inside a transaction, the account's row is held with a key-share lock to its end, so
 * a ban (`banUser` locks the row for update) either commits first and is seen here, or waits
 * for the transaction to commit. Key share, the weakest lock: it holds off the ban without
 * blocking the uploader's own quota count or a sign-in's write to the row.
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
  if (lock) query = query.forKeyShare();
  return bannedRow(await query.executeTakeFirst());
}
