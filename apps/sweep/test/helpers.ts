import { createDb, type Database, type UploadStatus } from "@archive/db";
import { putFragments, seedVersion, seedWork, type SeedWorkOptions } from "@archive/db/seed";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Kysely } from "kysely";
import worker, { type Env } from "../src/worker";

// Shared by the workerd tests. One database serves every test (test/global-setup.ts), so each
// seeds its own works; the bucket is each test's own.

const HOUR = 60 * 60 * 1000;

/** Runs `fn` with a Kysely on the test database, through the Worker's Hyperdrive. */
export async function withDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

type Handler = { scheduled: NonNullable<ExportedHandler<Env>["scheduled"]> };

/**
 * Fires the cron as Cloudflare would, `hoursLater` hours from now. Local R2 stamps every
 * object with the time it was put, so 25 hours later makes everything put so far older than
 * the sweep's 24 hours, and 0 keeps it all young.
 */
export async function runSweep(
  hoursLater: number,
  { handler = worker }: { handler?: Handler } = {},
): Promise<void> {
  const controller = createScheduledController({
    scheduledTime: Date.now() + hoursLater * HOUR,
    cron: "17 3 * * *",
  });
  const ctx = createExecutionContext();
  await handler.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

/** A random int4 AO3 work ID, so tests on the shared database don't collide. */
export const freshAo3WorkId = () => 100_000_000 + Math.floor(Math.random() * 2_000_000_000);

/** Synthetic image key: 64 lowercase hex, its own for each call. */
export const imageKey = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 64);

/** The `src` the processor gives an image of AO3 work `ao3WorkId`, as ingest stores it. */
export const imageSrc = (ao3WorkId: number, key: string) =>
  `https://content.rarepair.fans/works/${ao3WorkId}/img/${key}`;

/** A fragment showing each image, as the sanitizer leaves an `img`. */
export const withImages = (ao3WorkId: number, ...keys: string[]) =>
  keys.map((k) => `<p><img src="${imageSrc(ao3WorkId, k)}" alt=""></p>`).join("");

/** Puts synthetic image bytes at each key under the work's `img/` prefix. */
export async function putImages(ao3WorkId: number, ...keys: string[]): Promise<void> {
  await Promise.all(
    keys.map((k) => env.BUCKET.put(`works/${ao3WorkId}/img/${k}`, new Uint8Array([1, 2, 3]))),
  );
}

/** A work seeded as ingest leaves it, with its fragments put in R2. */
export async function seededWork(options: SeedWorkOptions) {
  const work = await withDb((db) => seedWork(db, options));
  await putFragments(env.BUCKET, work.fragments);
  return work;
}

/** A later version of a seeded work, held unless `current`, with its fragments put in R2. */
export async function seededVersion(
  work: { workId: string; ao3WorkId: number; userId: string },
  options: Parameters<typeof seedVersion>[2] = {},
) {
  const version = await withDb((db) => seedVersion(db, work, { current: false, ...options }));
  await putFragments(env.BUCKET, version.fragments);
  return version;
}

/**
 * An upload by `userId` (a new user when null) in `status`, with no version. Returns its id,
 * which names its prefix.
 */
export async function upload(userId: string | null, status: UploadStatus): Promise<string> {
  const id = crypto.randomUUID();
  await withDb(async (db) => {
    const user = userId ?? `sweep-${id}`;
    if (userId === null) {
      await db
        .insertInto("user")
        .values({
          id: user,
          name: "Sweep uploader",
          email: `${user}@example.test`,
          email_verified: true,
        })
        .execute();
    }
    await db
      .insertInto("uploads")
      .values({ id, user_id: user, r2_key: `uploads/${id}.epub`, bytes: 1024, status })
      .execute();
  });
  return id;
}

/**
 * Puts `chapters` synthetic fragments under `works/<ao3WorkId>/<uploadId>/`, as a job writes
 * them before its transaction. Returns their keys.
 */
export async function putPrefix(
  ao3WorkId: number,
  uploadId: string,
  chapters: number,
): Promise<string[]> {
  const keys = Array.from(
    { length: chapters },
    (_, i) => `works/${ao3WorkId}/${uploadId}/${i + 1}.html`,
  );
  await Promise.all(keys.map((k) => env.BUCKET.put(k, "<p>Synthetic fragment.</p>")));
  return keys;
}

/** The keys in the bucket under `prefix`, sorted. */
export async function bucketKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.BUCKET.list({ prefix, cursor });
    keys.push(...listed.objects.map((o) => o.key));
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return keys.sort();
}

/** Deletes every object in the bucket, which the tests share. */
export async function emptyBucket(): Promise<void> {
  const keys = await bucketKeys("");
  for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
}

/** Starts the sweep from the first folder, as on a fresh database. */
export const resetSweepState = () =>
  withDb((db) => db.updateTable("sweep_state").set({ after: null }).execute());
