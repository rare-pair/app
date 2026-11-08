// The one opt-out match: ingest's check, a moderator's approval of a held version and a request's
// reversal all ask it. Names are `pseud_norm`s, as `checkedNames` gives them.
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Whether any of `names` is on the active opt-out list. With `exceptRequest`, that request's own
 * opt-out doesn't count (a reversal asks whether anything else still covers a work). One bound
 * array, however long the byline: a list of values is one parameter each, and Postgres takes at
 * most 65,535.
 */
export async function isOptedOut(
  db: Kysely<Database>,
  names: string[],
  options: { exceptRequest?: string } = {},
): Promise<boolean> {
  if (names.length === 0) return false;
  let query = db
    .selectFrom("optouts")
    .select("id")
    .where("active", "=", true)
    .where(sql<boolean>`pseud_norm = any(${names}::text[])`);
  if (options.exceptRequest !== undefined) {
    query = query.where("request_id", "<>", options.exceptRequest);
  }
  return (await query.limit(1).executeTakeFirst()) !== undefined;
}
