import type { Database } from "@archive/db";
import type { Kysely } from "kysely";
import { imageRefs } from "./refs";

/** What the sweep uses of the bucket. */
export interface SweepBucket {
  list(options: R2ListOptions): Promise<R2Objects>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface SweepDeps {
  db: Kysely<Database>;
  bucket: SweepBucket;
  /** Only objects put before this are deleted. */
  cutoff: Date;
}

const IMAGE_KEY = /^[0-9a-f]{64}$/;
/** An upload's id, as Postgres's `gen_random_uuid()` writes it. Any other segment is left alone. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Keys per R2 list page and per delete call: R2's most. */
const PAGE = 1000;

/** Sweeps every `works/<ao3_work_id>/` folder. */
export async function sweep(deps: SweepDeps): Promise<void> {
  for (const folder of await listFolders(deps)) {
    const match = /^works\/(\d+)\/$/.exec(folder);
    if (match === null) continue;
    await sweepWork(deps, Number(match[1]));
  }
}

async function listFolders({ bucket }: SweepDeps): Promise<string[]> {
  const folders: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: "works/", delimiter: "/", limit: PAGE, cursor });
    folders.push(...page.delimitedPrefixes);
    if (!page.truncated) return folders;
    cursor = page.cursor;
  }
}

async function listAll(bucket: SweepBucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, limit: PAGE, cursor });
    objects.push(...page.objects);
    if (!page.truncated) return objects;
    cursor = page.cursor;
  }
}

async function deleteKeys(bucket: SweepBucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += PAGE) {
    await bucket.delete(keys.slice(i, i + PAGE));
  }
}

async function sweepWork(deps: SweepDeps, ao3WorkId: number): Promise<void> {
  const { db, bucket, cutoff } = deps;
  const folder = `works/${ao3WorkId}/`;
  const work = await db
    .selectFrom("works")
    .select(["id", "summary_html"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
  const versionPrefixes = new Set(
    work === undefined
      ? []
      : (
          await db
            .selectFrom("work_versions")
            .select("r2_prefix")
            .where("work_id", "=", work.id)
            .execute()
        ).map((v) => v.r2_prefix),
  );
  // Every `<upload_id>/` prefix under the folder: one level, beside `img/`.
  const prefixes: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: folder, delimiter: "/", limit: PAGE, cursor });
    prefixes.push(...page.delimitedPrefixes);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const candidates = new Map<string, string>();
  for (const prefix of prefixes) {
    const segment = prefix.slice(folder.length, -1);
    if (UPLOAD_ID.test(segment) && !versionPrefixes.has(prefix)) candidates.set(segment, prefix);
  }
  // The uploads a job may still be writing for: a prefix's own, or one already tied to the work.
  const inFlight = await db
    .selectFrom("uploads")
    .select("id")
    .where("status", "in", ["pending", "processing"])
    .where((eb) => {
      const arms = [];
      if (candidates.size > 0) arms.push(eb("id", "in", [...candidates.keys()]));
      if (work !== undefined) arms.push(eb("work_id", "=", work.id));
      return eb.or(arms);
    })
    .execute();
  for (const { id } of inFlight) candidates.delete(id);
  for (const prefix of candidates.values()) {
    const objects = await listAll(bucket, prefix);
    // A prefix goes whole or not at all: one object put since the cutoff keeps all of it.
    if (objects.some((o) => o.uploaded >= cutoff)) continue;
    await deleteKeys(
      bucket,
      objects.map((o) => o.key),
    );
  }
  // A job may be about to commit a version that references images already here.
  if (inFlight.length > 0) return;
  const referenced = new Set<string>();
  if (work !== undefined) {
    for (const key of imageRefs(work.summary_html ?? "", ao3WorkId)) referenced.add(key);
    const chapters = await db
      .selectFrom("chapters")
      .select("r2_key")
      .where("work_id", "=", work.id)
      .execute();
    for (const c of chapters) {
      const object = await bucket.get(c.r2_key);
      if (object === null) return;
      for (const key of imageRefs(await object.text(), ao3WorkId)) referenced.add(key);
    }
  }
  const img = `works/${ao3WorkId}/img/`;
  const unreferenced = (await listAll(bucket, img))
    .filter((o) => o.uploaded < cutoff)
    .map((o) => o.key)
    .filter((key) => {
      const name = key.slice(img.length);
      return IMAGE_KEY.test(name) && !referenced.has(name);
    });
  await deleteKeys(bucket, unreferenced);
}
