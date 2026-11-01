import type { Database } from "@archive/db";
import { sql, type Kysely } from "kysely";
import { imageRefs } from "./refs";

/**
 * Selected beside every read. Hyperdrive caches read queries (60 seconds by default) but never
 * one that calls a STABLE function such as this, so the sweep always sees the database as it is:
 * a stale "nothing in flight" or "no such version" would delete what a job just made. The
 * sweep's Hyperdrive config should have caching disabled too.
 */
const FRESH = sql<Date>`now()`.as("read_at");

/** An object in a listing, as far as the sweep reads it. */
export interface ListedObject {
  key: string;
  uploaded: Date;
}

/** One page of an R2 listing, as far as the sweep reads it. */
export interface Listing {
  objects: ListedObject[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

/** What the sweep uses of the bucket: R2's `list`, `get` and batch `delete`. */
export interface SweepBucket {
  list(options: {
    prefix: string;
    delimiter?: string;
    limit: number;
    cursor?: string;
    startAfter?: string;
  }): Promise<Listing>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(keys: string[]): Promise<void>;
}

/** What one run may spend. */
export interface Limits {
  /** Folders swept to the end. */
  works: number;
  /** R2 calls: each counts against the Worker's subrequest limit (10,000 on Workers Paid). */
  subrequests: number;
}

/**
 * Under the platform's limits (10,000 subrequests on Workers Paid; 5 minutes of CPU, set in
 * wrangler.jsonc, within a cron's 15 minutes of wall time). The subrequests bound the R2 work; the works bound the Postgres queries, at most seven a
 * work (two to look at the folder, two to read references, two to look again, one to save).
 */
export const LIMITS: Limits = { works: 1_000, subrequests: 8_000 };

export interface SweepDeps {
  db: Kysely<Database>;
  bucket: SweepBucket;
  /** Only objects put before this are deleted. */
  cutoff: Date;
  limits: Limits;
}

/** Why a work's images, or all of it, were left alone this run. */
export type SkipReason =
  | "in_flight"
  | "unreadable_fragment"
  | "changed"
  | "budget"
  | "error"
  | "killed";

/** What a run did: counts, AO3 work IDs and error class names only. */
export interface RunReport {
  works: number;
  imagesDeleted: number;
  prefixesDeleted: number;
  /** Works whose image pass didn't run, and why. */
  skipped: { ao3WorkId: number; reason: SkipReason; error?: string }[];
  /** The run reached the last folder: the next one starts from the first. */
  finished: boolean;
  /** Another run moved the saved place meanwhile, so this one stopped. */
  overlapped?: true;
  subrequestsLeft: number;
}

/** A folder ingest writes: the AO3 work ID in decimal, with no leading zero. */
const FOLDER = /^works\/([1-9]\d{0,9})\/$/;
/** Works that fail in one run before the run ends. */
const MAX_ERRORS = 3;
const MAX_INT4 = 2_147_483_647;
const IMAGE_KEY = /^[0-9a-f]{64}$/;
/** An upload's id, as Postgres's `gen_random_uuid()` writes it. Any other segment is left alone. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Keys per R2 list page and per delete call: R2's most. */
const PAGE = 1000;
/** R2 reads in flight at once: a Worker limits its simultaneous subrequests. */
const GET_POOL = 6;

/** The run's subrequest budget is spent. */
class BudgetSpent extends Error {}

/** An error's class name, never its message. */
// oxlint-disable-next-line deslop/no-unknown-parameters -- a caught value is unknown by contract
export function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
}

/**
 * Sweeps `works/<ao3_work_id>/` folders in R2's key order, from where the last run stopped,
 * until the limits are spent or the last folder is done. In each folder it deletes the
 * `<upload_id>/` prefixes no version points at and no pending or processing upload owns, then
 * the images under `img/` that no version references, all only when put before the cutoff. The
 * image pass runs only on a complete reference scan, with no upload of the work in flight:
 * anything less leaves every image of the work alone. Where it stopped is saved, even when it
 * throws.
 */
export async function sweep(deps: SweepDeps): Promise<RunReport> {
  const { db, limits } = deps;
  const budget = { left: limits.subrequests };
  const bucket = budgeted(deps.bucket, budget);
  const report: RunReport = {
    works: 0,
    imagesDeleted: 0,
    prefixesDeleted: 0,
    skipped: [],
    finished: false,
    subrequestsLeft: 0,
  };
  const state = await db
    .selectFrom("sweep_state")
    .select(["after", "current", FRESH])
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  let after = state.after;
  let current: string | null = null;
  // The last run ended inside this folder without clearing it: the platform killed it there
  // (memory, CPU or time). Passed over, or every run would die on it.
  if (state.current !== null) {
    const ao3WorkId = ao3WorkIdOf(state.current);
    if (ao3WorkId !== null) report.skipped.push({ ao3WorkId, reason: "killed" });
    after = past(state.current);
  }
  // Saved around every work, so a run the platform ends keeps what it did; and only over the
  // place this run last saw, so a run that overlaps another stops instead of moving it back.
  let saved = { after: state.after, current: state.current };
  const save = async (): Promise<boolean> => {
    if (after === saved.after && current === saved.current) return true;
    const result = await db
      .updateTable("sweep_state")
      .set({ after, current, updated_at: new Date() })
      .where("id", "=", 1)
      .where(sql<boolean>`"after" is not distinct from ${saved.after}`)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    saved = { after, current };
    return true;
  };
  let attempted = 0;
  let failure: { error: unknown } | null = null;
  try {
    let cursor: string | undefined;
    walk: for (;;) {
      // The first page starts after the saved key; the rest follow the listing's own cursor.
      const page = await bucket.list({
        prefix: "works/",
        delimiter: "/",
        limit: PAGE,
        ...(cursor === undefined ? { startAfter: after ?? undefined } : { cursor }),
      });
      for (const folder of page.delimitedPrefixes) {
        if (attempted >= limits.works) break walk;
        const ao3WorkId = ao3WorkIdOf(folder);
        if (ao3WorkId !== null) {
          attempted++;
          current = folder;
          if (!(await save())) {
            report.overlapped = true;
            break walk;
          }
          try {
            await sweepWork({ ...deps, bucket }, ao3WorkId, report);
            report.works++;
          } catch (error) {
            if (error instanceof BudgetSpent) {
              // A work too big for a whole run would stop every run on it: the first is passed.
              if (attempted === 1) {
                report.skipped.push({ ao3WorkId, reason: "budget" });
                after = past(folder);
              }
              break walk;
            }
            // Passed over, so one work that always fails doesn't stop every run on it; a few in
            // one run look like an outage, and end it.
            report.skipped.push({ ao3WorkId, reason: "error", error: errorCode(error) });
            if (report.skipped.filter((s) => s.reason === "error").length >= MAX_ERRORS) {
              after = past(folder);
              break walk;
            }
          }
        }
        after = past(folder);
        current = null;
        if (!(await save())) {
          report.overlapped = true;
          break walk;
        }
      }
      if (!page.truncated) {
        after = null;
        report.finished = true;
        break;
      }
      cursor = page.cursor;
    }
  } catch (error) {
    if (!(error instanceof BudgetSpent)) failure = { error };
  }
  report.subrequestsLeft = budget.left;
  // The run ended on its own: no folder is left marked as the one it died in.
  current = null;
  try {
    if (!report.overlapped && !(await save())) report.overlapped = true;
  } catch (error) {
    // The run's own failure, if it had one, is the one worth reporting.
    failure ??= { error };
  }
  if (failure !== null) throw failure.error;
  return report;
}

/** The bucket, each call spending one subrequest, refused once the budget is spent. */
function budgeted(bucket: SweepBucket, budget: { left: number }): SweepBucket {
  const spend = () => {
    if (budget.left <= 0) throw new BudgetSpent();
    budget.left--;
  };
  return {
    list: async (options) => (spend(), bucket.list(options)),
    get: async (key) => (spend(), bucket.get(key)),
    delete: async (keys) => (spend(), bucket.delete(keys)),
  };
}

/** The AO3 work ID a folder is named for, or null for any other name: left alone. */
function ao3WorkIdOf(folder: string): number | null {
  const match = FOLDER.exec(folder);
  if (match === null) return null;
  const id = Number(match[1]);
  return id >= 1 && id <= MAX_INT4 ? id : null;
}

/**
 * A key past every object in `folder` and before the next folder: every segment ingest writes
 * (`img`, an upload id) sorts below `~`, and `works/<n>/~` below `works/<n>0/`.
 */
const past = (folder: string) => `${folder}~`;

async function listAll(
  bucket: SweepBucket,
  prefix: string,
  delimiter?: string,
): Promise<{ objects: ListedObject[]; prefixes: string[] }> {
  const objects: ListedObject[] = [];
  const prefixes: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, delimiter, limit: PAGE, cursor });
    objects.push(...page.objects);
    prefixes.push(...page.delimitedPrefixes);
    if (!page.truncated) return { objects, prefixes };
    cursor = page.cursor;
  }
}

async function deleteKeys(bucket: SweepBucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += PAGE) {
    await bucket.delete(keys.slice(i, i + PAGE));
  }
}

/** A work folder as R2 and Postgres show it at one moment. */
interface FolderState {
  /** The upload ids named by the folder's `<upload_id>/` prefixes. */
  uploads: Set<string>;
  hasImages: boolean;
  /** Uploads of the work still pending or processing. */
  inFlight: Set<string>;
  versionPrefixes: Set<string>;
}

/**
 * The folder's prefixes, then its uploads in flight, then its versions' prefixes: in that order,
 * so a job that commits between the two reads is in flight to the first or versioned to the
 * second, never neither (its upload leaves `processing` in the transaction that adds its version).
 */
async function folderState(
  { db, bucket }: SweepDeps,
  ao3WorkId: number,
  folder: string,
): Promise<FolderState> {
  const { prefixes } = await listAll(bucket, folder, "/");
  const uploads = new Set(
    prefixes.map((p) => p.slice(folder.length, -1)).filter((s) => UPLOAD_ID.test(s)),
  );
  // A job writes its fragments before its images, so its prefix ties it to the work once it
  // writes anything. Ingest sets `work_id` only as a job ends, so the `work_id` arm matches no
  // job today; it is there for an upload re-run once tied to its work. A job that hasn't written
  // yet can't be tied to any work: the recheck before deleting narrows that window.
  const inFlight = await db
    .selectFrom("uploads")
    .select(["id", FRESH])
    .where("status", "in", ["pending", "processing"])
    .where((eb) =>
      eb.or([
        ...(uploads.size > 0 ? [eb("id", "in", [...uploads])] : []),
        eb(
          "work_id",
          "in",
          eb.selectFrom("works").select("id").where("ao3_work_id", "=", ao3WorkId),
        ),
      ]),
    )
    .execute();
  const versions = await db
    .selectFrom("work_versions")
    .innerJoin("works", "works.id", "work_versions.work_id")
    .select(["work_versions.r2_prefix", FRESH])
    .where("works.ao3_work_id", "=", ao3WorkId)
    .execute();
  return {
    uploads,
    hasImages: prefixes.includes(`${folder}img/`),
    inFlight: new Set(inFlight.map((u) => u.id)),
    versionPrefixes: new Set(versions.map((v) => v.r2_prefix)),
  };
}

/** Whether nothing a version could reference has changed between the two states. */
function unchanged(before: FolderState, now: FolderState): boolean {
  return (
    now.inFlight.size === 0 &&
    [...now.uploads].every((id) => before.uploads.has(id)) &&
    now.versionPrefixes.size === before.versionPrefixes.size &&
    [...now.versionPrefixes].every((p) => before.versionPrefixes.has(p))
  );
}

async function sweepWork(deps: SweepDeps, ao3WorkId: number, report: RunReport): Promise<void> {
  const { db, bucket, cutoff } = deps;
  const folder = `works/${ao3WorkId}/`;
  const state = await folderState(deps, ao3WorkId, folder);
  const candidates = [...state.uploads].filter(
    (id) => !state.inFlight.has(id) && !state.versionPrefixes.has(`${folder}${id}/`),
  );
  for (const uploadId of candidates) {
    const { objects } = await listAll(bucket, `${folder}${uploadId}/`);
    // A prefix goes whole or not at all: one object put since the cutoff keeps all of it.
    if (objects.length === 0 || objects.some((o) => o.uploaded >= cutoff)) continue;
    await deleteKeys(
      bucket,
      objects.map((o) => o.key),
    );
    report.prefixesDeleted++;
  }
  if (!state.hasImages) return;
  // A job may be about to commit a version that references images already here.
  if (state.inFlight.size > 0) {
    report.skipped.push({ ao3WorkId, reason: "in_flight" });
    return;
  }
  const img = `${folder}img/`;
  // Old enough to go, if nothing references them. Listed first, so a work with none reads no
  // fragments.
  const old = (await listAll(bucket, img)).objects.filter(
    (o) => o.uploaded < cutoff && IMAGE_KEY.test(o.key.slice(img.length)),
  );
  if (old.length === 0) return;
  const work = await db
    .selectFrom("works")
    .select(["id", "summary_html", FRESH])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  const referenced = await referencedImages(
    deps,
    ao3WorkId,
    work,
    new Set(old.map((o) => o.key.slice(img.length))),
  );
  if (referenced === null) {
    report.skipped.push({ ao3WorkId, reason: "unreadable_fragment" });
    return;
  }
  // Looked at again just before deleting: a job that started, or a version that arrived, during
  // the scan may reference what the scan didn't see.
  if (!unchanged(state, await folderState(deps, ao3WorkId, folder))) {
    report.skipped.push({ ao3WorkId, reason: "changed" });
    return;
  }
  const unreferenced = old
    .filter((o) => !referenced.has(o.key.slice(img.length)))
    .map((o) => o.key);
  await deleteKeys(bucket, unreferenced);
  report.imagesDeleted += unreferenced.length;
}

/**
 * Which of `candidates` any version of the work references: in every fragment of every version
 * (a held one can be made current), and in the work's summary. The scan stops early once every
 * candidate is referenced, since nothing is left to delete. Null when a fragment is missing, so
 * the scan is incomplete.
 */
async function referencedImages(
  { db, bucket }: SweepDeps,
  ao3WorkId: number,
  work: { id: string; summary_html: string | null } | undefined,
  candidates: Set<string>,
): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  const note = (html: string) => {
    for (const key of imageRefs(html, ao3WorkId)) if (candidates.has(key)) referenced.add(key);
  };
  if (work === undefined) return referenced;
  note(work.summary_html ?? "");
  const chapters = await db
    .selectFrom("chapters")
    .select(["r2_key", FRESH])
    .where("work_id", "=", work.id)
    .execute();
  // SAFETY: the readers below assign it; TypeScript can't see a callback's assignment.
  let complete = true as boolean;
  // SAFETY: as `complete`.
  let stop = false as boolean;
  const queue = chapters.values();
  const reader = async () => {
    for (const c of queue) {
      if (stop || referenced.size === candidates.size) return;
      try {
        const object = await bucket.get(c.r2_key);
        if (object === null) {
          complete = false;
          stop = true;
          return;
        }
        note(await object.text());
      } catch (error) {
        // The other readers stop too, rather than spend the budget on a work already failed.
        stop = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GET_POOL, chapters.length) }, reader));
  return complete ? referenced : null;
}
