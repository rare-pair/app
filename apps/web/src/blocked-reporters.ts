// Which reporters of a work match a blocked requester by IP hash (X6, #67). A block stores the
// requester's IP as an HMAC (ip-hash.ts), a report stores no address, so the match is made on
// the reporter's account: each address of its sessions is hashed the same way and compared
// with the blocks. HMAC can't run in SQL, so this is the app's half; the email half is in the
// hiding UPDATE's count (packages/db queries.ts `countedReporters`), which skips the ids
// returned here. It sees only sessions that still exist: sessions expire and are deleted, and
// an account with none left matches by email only. Evaluated at every report, so a block
// made after an account reported also leaves its older report out of the next count.
// Never logs, and the hashes go nowhere but the comparison.

import type { Database } from "@archive/db";
import type { Kysely } from "kysely";
import { ipHash } from "./ip-hash";

/**
 * The accounts among `selfId` (the reporter just stored, always a candidate: a read may come
 * from Hyperdrive's cache and miss its report) and the work's other reporters of counted
 * reports, one of whose sessions' addresses hashes to a blocked IP hash. A session with no
 * address matches nothing, so a block on the fixed marker for "no address" never ignores
 * anyone.
 */
export async function blockedReporterIds(
  db: Kysely<Database>,
  key: string,
  workId: string,
  selfId: string,
): Promise<string[]> {
  const blocks = await db
    .selectFrom("requester_blocks")
    .select("ip_hash")
    .where("ip_hash", "is not", null)
    .execute();
  if (blocks.length === 0) return [];
  const blocked = new Set(blocks.map((b) => b.ip_hash));
  const reporters = await db
    .selectFrom("reports")
    .select("reporter_id")
    .distinct()
    .where("work_id", "=", workId)
    .where("status", "=", "open")
    .where("kind", "<>", "wrong_version")
    .execute();
  const candidates = [...new Set([selfId, ...reporters.map((r) => r.reporter_id)])];
  const sessions = await db
    .selectFrom("session")
    .select(["user_id", "ip_address"])
    .where("user_id", "in", candidates)
    .where("ip_address", "is not", null)
    .execute();
  const addresses = [...new Set(sessions.flatMap((s) => (s.ip_address ? [s.ip_address] : [])))];
  const hashes = new Map(
    await Promise.all(addresses.map(async (a) => [a, await ipHash(key, a)] as const)),
  );
  const matched = new Set<string>();
  for (const session of sessions) {
    const hash = session.ip_address === null ? undefined : hashes.get(session.ip_address);
    if (hash !== undefined && blocked.has(hash)) matched.add(session.user_id);
  }
  return [...matched];
}
