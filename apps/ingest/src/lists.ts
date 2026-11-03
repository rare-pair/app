import { normalizePseud, type Database } from "@archive/db";
import type { ParsedWork } from "@archive/epub";
import { sql, type Kysely } from "kysely";
import { isDataErrorState, sqlState } from "./sql-state";
import { parseWorkId } from "./work-id";

/**
 * A DMCA notice's status once a moderator has removed its work. Only such a notice puts the
 * work's AO3 ID on the takedown list; a pending one blocks nothing. Whatever approves a notice
 * writes this value (orchestrator ruling for #34; X8 #68, MOD1 #44).
 */
export const TAKEDOWN_REMOVED = "removed";

/**
 * The lists refused a value in the file (a NUL byte in a pseud, say): the same file fails the
 * same way on every attempt, so it is recorded, not retried. `code` is short and fixed, never
 * text from the file: it may reach an uploader's page.
 */
export class ListCheckRejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Whether the work may not be hosted (ARCHITECTURE, EPUB processor, step 4): a byline pseud
 * matches an active opt-out by its `pseud_norm`, any one author being enough, or its AO3 work
 * ID is on the takedown list, the works a moderator removed after a DMCA notice. Throws when
 * the lists can't be read, so a job never saves past an unread list, and
 * `ListCheckRejected` when a list refuses a value in the file.
 */
export async function onRejectList(
  db: Kysely<Database>,
  work: Pick<ParsedWork, "ao3WorkId" | "authors">,
): Promise<boolean> {
  // Both are read in every case: each throws if its list can't be.
  const [optedOutAuthor, takenDownWork] = await Promise.all([
    optedOut(db, checkedPseuds(work.authors)).catch(rejectDataError),
    takenDown(db, work.ao3WorkId).catch(rejectDataError),
  ]);
  return optedOutAuthor || takenDownWork;
}

// oxlint-disable-next-line deslop/no-unknown-parameters -- a caught value is unknown by contract
function rejectDataError(error: unknown): never {
  const state = sqlState(error);
  if (isDataErrorState(state)) throw new ListCheckRejected(`optout_check_rejected_${state}`);
  throw error;
}

/**
 * The `pseud_norm`s the opt-out check reads, one per distinct name: blank ones (nothing left
 * once whitespace and invisible characters go) match no opt-out, as the schema refuses a
 * blank `pseud_norm`, so they are left out; so is the "Anonymous" placeholder the processor
 * gives a byline with no profile link, which names nobody. An author with a profile link whose
 * user is "Anonymous" is a user, and stays.
 */
export function checkedPseuds(authors: ParsedWork["authors"]): string[] {
  const norms = authors
    .filter((a) => a.user !== null || normalizePseud(a.pseud) !== "anonymous")
    .map((a) => normalizePseud(a.pseud));
  return [...new Set(norms)].filter((norm) => norm !== "");
}

async function optedOut(db: Kysely<Database>, pseudNorms: string[]): Promise<boolean> {
  if (pseudNorms.length === 0) return false;
  // One bound array, however long the byline: a list of values is one parameter each, and
  // Postgres takes at most 65,535.
  const row = await db
    .selectFrom("optouts")
    .select("id")
    .where("active", "=", true)
    .where(sql<boolean>`pseud_norm = any(${pseudNorms}::text[])`)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

async function takenDown(db: Kysely<Database>, ao3WorkId: string): Promise<boolean> {
  // An ID that isn't a `works` key is on no list; the save refuses the file as `bad_work_id`.
  const id = parseWorkId(ao3WorkId);
  if (id === null) return false;
  const row = await db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .select("takedowns.id")
    .where("works.ao3_work_id", "=", id)
    // A restored work is uploadable again.
    .where("works.status", "=", "removed")
    .where("takedowns.status", "=", TAKEDOWN_REMOVED)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
