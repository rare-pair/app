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

/** Well under the platform's limits, so one daily run always ends cleanly. */
export const LIMITS: Limits = { works: 200, subrequests: 8_000 };

export interface SweepDeps {
  db: Kysely<Database>;
  bucket: SweepBucket;
  /** Only objects put before this are deleted. */
  cutoff: Date;
  limits: Limits;
}

/** Why a work's images were left alone this run. */
export type SkipReason = "in_flight" | "unreadable_fragment" | "budget";

/** What a run did: counts and AO3 work IDs only. */
export interface RunReport {
  works: number;
  imagesDeleted: number;
  prefixesDeleted: number;
  /** Works whose image pass didn't run, and why. */
  skipped: { ao3WorkId: number; reason: SkipReason }[];
  /** The run reached the last folder: the next one starts from the first. */
  finished: boolean;
  subrequestsLeft: number;
}

const FOLDER = /^works\/(\d{1,10})\/$/;
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
            if (!(error instanceof BudgetSpent)) throw error;
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

async function sweepWork(deps: SweepDeps, ao3WorkId: number, report: RunReport): Promise<void> {
  const { db, bucket, cutoff } = deps;
  const folder = `works/${ao3WorkId}/`;
  const work = await db
    .selectFrom("works")
    .select(["id", "summary_html"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  const [versions, listing] = await Promise.all([
    db
      .selectFrom("work_versions")
      .innerJoin("works", "works.id", "work_versions.work_id")
      .select("work_versions.r2_prefix")
      .where("works.ao3_work_id", "=", ao3WorkId)
      .execute(),
    // Every `<upload_id>/` prefix under the folder: one level, beside `img/`.
    listAll(bucket, folder, "/"),
  ]);
  const versionPrefixes = new Set(versions.map((v) => v.r2_prefix));
  const candidates = new Set<string>();
  for (const prefix of listing.prefixes) {
    const segment = prefix.slice(folder.length, -1);
    if (UPLOAD_ID.test(segment) && !versionPrefixes.has(prefix)) candidates.add(segment);
  }
  // The uploads a job may still be writing for: a prefix's own (a job writes its fragments
  // before its images), or one already tied to the work. A `pending` upload with neither can't
  // be tied to any work.
  const inFlight =
    candidates.size === 0 && work === undefined
      ? []
      : await db
          .selectFrom("uploads")
          .select("id")
          .where("status", "in", ["pending", "processing"])
          .where((eb) =>
            eb.or([
              ...(candidates.size > 0 ? [eb("id", "in", [...candidates])] : []),
              ...(work !== undefined ? [eb("work_id", "=", work.id)] : []),
            ]),
          )
          .execute();
  for (const { id } of inFlight) candidates.delete(id);
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
  const img = `${folder}img/`;
  if (!listing.prefixes.includes(img)) return;
  // A job may be about to commit a version that references images already here.
  if (inFlight.length > 0) {
    report.skipped.push({ ao3WorkId, reason: "in_flight" });
    return;
  }
  // Old enough to go, if nothing references them. Listed first, so a work with none reads no
  // fragments.
  const old = (await listAll(bucket, img)).objects.filter(
    (o) => o.uploaded < cutoff && IMAGE_KEY.test(o.key.slice(img.length)),
  );
  if (old.length === 0) return;
  const referenced = await referencedImages(deps, ao3WorkId, work);
  if (referenced === null) {
    report.skipped.push({ ao3WorkId, reason: "unreadable_fragment" });
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
