// What the content host may serve (ARCHITECTURE, Author requests & takedowns): read on a cache
// miss, before any byte of an image or an original goes out. One row each, by a primary or
// unique key, and no more than a status: never a hide cause.

import type { Kysely } from "kysely";
import type { Database } from "./schema";

/** `serve`, or `hidden` (451), or `refuse` (404: removed, unknown, held or without a work). */
export type ContentAccess = "serve" | "hidden" | "refuse";

const MAX_INT4 = 2_147_483_647;

const byWorkStatus = (status: string | undefined): ContentAccess =>
  status === "live" ? "serve" : status === "hidden" ? "hidden" : "refuse";

/**
 * Whether an image of AO3 work `ao3WorkId` may be served: only a `live` work's. A `processing`
 * work isn't public yet, so its images are refused with the unknown and the removed.
 */
export async function getImageAccess(
  db: Kysely<Database>,
  ao3WorkId: number,
): Promise<ContentAccess> {
  if (!Number.isInteger(ao3WorkId) || ao3WorkId < 1 || ao3WorkId > MAX_INT4) return "refuse";
  const row = await db
    .selectFrom("works")
    .select("works.status")
    .where("works.ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  return byWorkStatus(row?.status);
}

/**
 * Whether the original of upload `uploadId` may be served. It follows its work's status, and
 * only a `live` or `duplicate` upload is public: a held version's is never (404 to the public),
 * and an upload with no work (refused, or still in flight) has no status to follow, so it is
 * refused. Those answer 404 whatever their work's status, so the answer says nothing about it.
 */
export async function getOriginalAccess(
  db: Kysely<Database>,
  uploadId: string,
): Promise<ContentAccess> {
  const row = await db
    .selectFrom("uploads")
    .leftJoin("works", "works.id", "uploads.work_id")
    .select(["uploads.status as upload_status", "works.status as work_status"])
    .where("uploads.id", "=", uploadId)
    .executeTakeFirst();
  if (!row?.work_status) return "refuse";
  // Only a published upload says anything about its work: a held one is a 404 either way.
  const published = row.upload_status === "live" || row.upload_status === "duplicate";
  return published ? byWorkStatus(row.work_status) : "refuse";
}
