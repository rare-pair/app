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

async function sweepWork(deps: SweepDeps, ao3WorkId: number): Promise<void> {
  const { db, bucket, cutoff } = deps;
  const work = await db
    .selectFrom("works")
    .select(["id", "summary_html"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirst();
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
  for (let i = 0; i < unreferenced.length; i += PAGE) {
    await bucket.delete(unreferenced.slice(i, i + PAGE));
  }
}
