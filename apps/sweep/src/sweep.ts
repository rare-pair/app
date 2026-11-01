import type { Database } from "@archive/db";
import type { Kysely } from "kysely";
import { imageRefs } from "./refs";

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
 * Well under the platform's limits, so one daily run always ends cleanly. The subrequests bound
 * the R2 work; the works bound the Postgres queries (about four a work).
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
export type SkipReason = "in_flight" | "unreadable_fragment" | "changed" | "budget" | "error";

/** What a run did: counts, AO3 work IDs and error class names only. */
export interface RunReport {
  works: number;
  imagesDeleted: number;
  prefixesDeleted: number;
  /** Works whose image pass didn't run, and why. */
  skipped: { ao3WorkId: number; reason: SkipReason; error?: string }[];
  /** The run reached the last folder: the next one starts from the first. */
  finished: boolean;
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
    .select("after")
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  let after = state.after;
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
        if (report.works >= limits.works) break walk;
        const ao3WorkId = ao3WorkIdOf(folder);
        if (ao3WorkId !== null) {
          try {
            await sweepWork({ ...deps, bucket }, ao3WorkId, report);
          } catch (error) {
            if (!(error instanceof BudgetSpent)) {
              // Passed over, so one work that always fails doesn't stop every run on it; a few
              // in one run look like an outage, and end it.
              report.skipped.push({ ao3WorkId, reason: "error", error: errorCode(error) });
              after = past(folder);
              if (report.skipped.filter((s) => s.reason === "error").length >= MAX_ERRORS) {
                break walk;
              }
              continue;
            }
            // A work too big for a whole run would stop every run on it: the first is passed.
            if (report.works === 0) {
              report.skipped.push({ ao3WorkId, reason: "budget" });
              after = past(folder);
            }
            break walk;
          }
          report.works++;
        }
        after = past(folder);
      }
      if (!page.truncated) {
        after = null;
        report.finished = true;
        break;
      }
      cursor = page.cursor;
    }
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
  } finally {
    report.subrequestsLeft = budget.left;
    await db
      .updateTable("sweep_state")
      .set({ after, updated_at: new Date() })
      .where("id", "=", 1)
      .execute();
  }
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
  // A job writes its fragments before its images, so its prefix ties it to the work; one
  // already tied to the work by `work_id` counts too. A `pending` upload with neither can't be
  // tied to any work.
  const inFlight = await db
    .selectFrom("uploads")
    .select("id")
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
    .select("work_versions.r2_prefix")
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
    .select(["id", "summary_html"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  const referenced = await referencedImages(deps, ao3WorkId, work);
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
 * The image keys any version of the work references: in every fragment of every version
 * (a held one can be made current), and in the work's summary. Null when a fragment is missing,
 * so the scan is incomplete.
 */
async function referencedImages(
  { db, bucket }: SweepDeps,
  ao3WorkId: number,
  work: { id: string; summary_html: string | null } | undefined,
): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  if (work === undefined) return referenced;
  for (const key of imageRefs(work.summary_html ?? "", ao3WorkId)) referenced.add(key);
  const chapters = await db
    .selectFrom("chapters")
    .select("r2_key")
    .where("work_id", "=", work.id)
    .execute();
  // SAFETY: the readers below assign it; TypeScript can't see a callback's assignment.
  let complete = true as boolean;
  const queue = chapters.values();
  const reader = async () => {
    for (const c of queue) {
      if (!complete) return;
      const object = await bucket.get(c.r2_key);
      if (object === null) {
        complete = false;
        return;
      }
      for (const key of imageRefs(await object.text(), ao3WorkId)) referenced.add(key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GET_POOL, chapters.length) }, reader));
  return complete ? referenced : null;
}
