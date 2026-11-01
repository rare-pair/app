import { createDb, getLiveWork, insertUpload, type Database } from "@archive/db";
import { seedWork, type SeedWorkOptions } from "@archive/db/seed";
import { processEpub, type ParsedWork } from "@archive/epub";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import worker, { ingestWorker, type Steps } from "../src/worker";

// Shared by the workerd tests. One database serves every test file (test/global-setup.ts),
// so each upload gets its own user and ids.

type Handler = Pick<Required<typeof worker>, "queue">;

/** Runs `fn` with a Kysely on the test database, through the Worker's Hyperdrive. */
async function withDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/**
 * A `pending` upload by a new user, with `bytes` put at its R2 key. With `bytes` null,
 * nothing is put, as when the object has expired. Returns the upload's id.
 */
export async function pendingUpload(bytes: Uint8Array | null): Promise<string> {
  const id = crypto.randomUUID();
  const userId = `ingest-${id}`;
  const r2Key = `uploads/${id}.epub`;
  await withDb(async (db) => {
    await db
      .insertInto("user")
      .values({
        id: userId,
        name: "Ingest uploader",
        email: `${userId}@example.test`,
        email_verified: true,
      })
      .execute();
    await insertUpload(db, { id, userId, r2Key, bytes: bytes?.byteLength ?? 0 });
  });
  if (bytes !== null) await env.BUCKET.put(r2Key, bytes);
  return id;
}

/** The upload's row, as the job leaves it. */
export const uploadRow = (id: string) =>
  withDb((db) =>
    db
      .selectFrom("uploads")
      .select(["status", "lease_until", "error_stage", "error", "work_id"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );

/** Runs the queue handler on one batch of message bodies, and returns the queue's result. */
export async function deliver(
  bodies: unknown[],
  { attempts = 1, handler = worker }: { attempts?: number; handler?: Handler } = {},
) {
  const batch = createMessageBatch(
    "ingest",
    bodies.map((body, i) => ({ id: `msg-${i}`, timestamp: new Date(1000), attempts, body })),
  );
  const ctx = createExecutionContext();
  await handler.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

/**
 * Puts the upload in `processing` with its lease ending `interval` from now (a Postgres
 * interval, negative for an expired lease). Returns the new `lease_until`.
 */
export async function setLease(id: string, interval: string): Promise<Date> {
  const row = await withDb((db) =>
    db
      .updateTable("uploads")
      .set({ status: "processing", lease_until: sql<Date>`now() + ${interval}::interval` })
      .where("id", "=", id)
      .returning("lease_until")
      .executeTakeFirstOrThrow(),
  );
  // SAFETY: the update above has just set it.
  return row.lease_until as Date;
}

/**
 * A processor step that holds each job until `release()`: `entered` resolves once the
 * first job is inside it, and `running`/`most` count the jobs inside it now and at most.
 */
export function gated() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const counts = { running: 0, most: 0 };
  const process: Steps["process"] = async (bytes) => {
    counts.running++;
    counts.most = Math.max(counts.most, counts.running);
    enter();
    await released;
    try {
      return await processEpub(bytes);
    } finally {
      counts.running--;
    }
  };
  return { process, entered, release, counts };
}

/**
 * The queue handler with `steps` over the real ones, watched: `parsed` gets each epub the
 * job hands the processor, in order.
 */
export function watchedWorker(steps: Partial<Steps> = {}) {
  const parsed: Uint8Array[] = [];
  const process = steps.process ?? processEpub;
  const handler = ingestWorker({
    ...steps,
    process: async (bytes) => {
      parsed.push(bytes);
      return process(bytes);
    },
  });
  return { handler, parsed };
}

/**
 * An opt-out with `pseudNorm` as given, and the `opt_out` request it comes from. Returns the
 * opt-out's id. The text is synthetic.
 */
export function addOptOut(pseudNorm: string): Promise<string> {
  return withDb(async (db) => {
    const request = await db
      .insertInto("requests")
      .values({
        kind: "opt_out",
        pseud_norm: pseudNorm,
        contact_email: "requester@example.test",
        statement: "A synthetic statement.",
        ip_hash: "test-ip-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const optOut = await db
      .insertInto("optouts")
      .values({ pseud_norm: pseudNorm, request_id: request.id, active: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    return optOut.id;
  });
}

/** Reverses the opt-out, as a moderator does for a mistaken one. */
export const deactivateOptOut = (id: string) =>
  withDb((db) => db.updateTable("optouts").set({ active: false }).where("id", "=", id).execute());

/** A DMCA notice on the work, in the notice's `status`: `TAKEDOWN_REMOVED` once acted on. */
export const addTakedown = (workId: string, status: string) =>
  withDb((db) =>
    db
      .insertInto("takedowns")
      .values({ work_id: workId, requester: "A rights holder", basis: "A stated basis", status })
      .execute(),
  );

/** A work seeded as ingest leaves it (`@archive/db/seed`). */
export const seededWork = (options: SeedWorkOptions) => withDb((db) => seedWork(db, options));

/** Whether any work has the AO3 work ID. */
export const workExists = (ao3WorkId: number) =>
  withDb(async (db) => {
    const row = await db
      .selectFrom("works")
      .select("id")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirst();
    return row !== undefined;
  });

/** A lowercase token, to keep a test's pseud its own on the shared database. */
export const token = () => crypto.randomUUID().slice(0, 8);

/**
 * A random int4 AO3 work ID, well above `ao3Epub`'s default. It overlaps the range `seedWork`
 * draws from, so a clash with a seeded work is possible but negligibly unlikely.
 */
export const freshAo3WorkId = () => 100_000_000 + Math.floor(Math.random() * 2_000_000_000);

/**
 * Uploads a synthetic epub of AO3 work `workId` and runs its job, as `ingestUpload` does.
 */
export const ingestEpub = (workId: number, ...pseuds: string[]) =>
  ingestUpload(ao3Epub({ workId }), ...pseuds);

/**
 * Uploads `epub` and runs its job up to the save step, with the byline `pseuds` over the epub's
 * own (the synthetic epubs all carry one byline), or the epub's own when none are given. The
 * save step is a stub that writes nothing: it records the id of each upload that reached it, in
 * `saved`. Returns that, the upload's id and row, and the queue's result.
 */
export async function ingestUpload(epub: Uint8Array, ...pseuds: string[]) {
  const id = await pendingUpload(epub);
  const saved: string[] = [];
  const process: Steps["process"] = async (bytes) => {
    const work = await processEpub(bytes);
    return pseuds.length === 0
      ? work
      : { ...work, authors: pseuds.map((pseud) => ({ pseud, user: null })) };
  };
  const { handler } = watchedWorker({
    process,
    save: async (upload) => void saved.push(upload.id),
  });
  const result = await deliver([{ upload_id: id }], { handler });
  return { id, row: await uploadRow(id), saved, result };
}

type Ingested = Awaited<ReturnType<typeof ingestUpload>>;

/** Expects the upload rejected as `opted_out`: final and acked, with no work, never saved. */
export function expectOptedOut({ row, saved, result }: Ingested) {
  expect(row.status).toBe("opted_out");
  expect(row.error_stage).toBe("process");
  expect(row.error).toBe("opted_out");
  expect(row.work_id).toBeNull();
  expect(row.lease_until).toBeNull();
  // Before anything is written: the save step never ran.
  expect(saved).toEqual([]);
  expect(result.explicitAcks).toEqual(["msg-0"]);
  expect(result.retryMessages).toEqual([]);
}

/** Expects the upload not rejected as `opted_out`: the job went on to the save step. */
export function expectNotOptedOut({ id, row, saved }: Ingested) {
  expect(row.status).not.toBe("opted_out");
  expect(saved).toEqual([id]);
}

/** The bucket step: the real bucket, running `hook` with each key before its `put`. */
export const beforePut =
  (hook: (key: string) => Promise<void>): NonNullable<Steps["bucket"]> =>
  (real) => ({
    get: real.get.bind(real),
    put: async (key, value, options) => {
      await hook(key);
      return real.put(key, value, options);
    },
  });

/** The bucket step: the real bucket, with a `put` of `key` that fails as R2 down would. */
export const failingPut = (key: string) =>
  beforePut(async (k) => {
    if (k === key) throw new Error("injected R2 failure");
  });

/**
 * A parsed work, as the processor hands it to the save step, with `overrides`. Synthetic
 * text, and its own AO3 work ID.
 */
export function parsedWork(overrides: Partial<ParsedWork> = {}): ParsedWork {
  return {
    ao3WorkId: String(freshAo3WorkId()),
    title: "Synthetic Work",
    authors: [{ pseud: "someone", user: "someone" }],
    rating: "General Audiences",
    warnings: ["No Archive Warnings Apply"],
    categories: [],
    fandoms: ["Test Fandom"],
    relationships: [],
    characters: [],
    freeforms: [],
    language: "English",
    series: [],
    stats: {
      published: "2020-01-02",
      updated: null,
      completed: null,
      words: 3,
      chapters: { posted: 1, total: 1 },
    },
    summaryHtml: "<p>A synthetic summary.</p>",
    notesHtml: null,
    endNotesHtml: null,
    chapters: [{ n: 1, title: "One", html: "<p>marker-only-chapter text.</p>", words: 3 }],
    images: [],
    rawMeta: {},
    reviewReasons: [],
    ...overrides,
  };
}

/**
 * What the database holds of a job's save: `works` rows for the AO3 work ID, versions from
 * the upload, and `tags` rows with any of `tagNames`.
 */
export const savedRows = (ao3WorkId: number, uploadId: string, tagNames: string[] = []) =>
  withDb(async (db) => ({
    works: await db
      .selectFrom("works")
      .select(["id", "status", "current_version_id", "raw_meta"])
      .where("ao3_work_id", "=", ao3WorkId)
      .execute(),
    versions: await db
      .selectFrom("work_versions")
      .select("id")
      .where("upload_id", "=", uploadId)
      .execute(),
    tags:
      tagNames.length === 0
        ? []
        : await db.selectFrom("tags").select("name").where("name", "in", tagNames).execute(),
  }));

/** The work as the reader gets it (`getLiveWork`), or null when it isn't live. */
export const liveWork = (ao3WorkId: number) => withDb((db) => getLiveWork(db, ao3WorkId));

/**
 * The bucket step, watched: before each `put` it records the key and whether the `works` row
 * for `ao3WorkId` existed yet, reading through its own connection. Call `close()` after.
 */
export function watchedPuts(ao3WorkId: number) {
  const probe = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  const puts: { key: string; workExisted: boolean }[] = [];
  const bucket = beforePut(async (key) => {
    const row = await probe
      .selectFrom("works")
      .select("id")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirst();
    puts.push({ key, workExisted: row !== undefined });
  });
  return { bucket, puts, close: () => probe.destroy() };
}

/** The keys in the bucket under `prefix`, sorted. */
export async function bucketKeys(prefix: string): Promise<string[]> {
  const listed = await env.BUCKET.list({ prefix });
  return listed.objects.map((o) => o.key).sort();
}

/** The text of the object at `key`, or null. */
export async function bucketText(key: string): Promise<string | null> {
  const object = await env.BUCKET.get(key);
  return object === null ? null : object.text();
}

/** SHA-256 of `bytes` as lowercase hex, the key an image is stored under. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Synthetic image bytes: the file signature of `type`, then `fill` repeated, so each `fill`
 * hashes differently. Enough for the processor's sniff, not a decodable image.
 */
export function imageBytes(type: "png" | "jpeg" | "gif" | "webp", fill: string): Uint8Array {
  const head = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff, 0xe0],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  }[type];
  return new Uint8Array([...head, ...new TextEncoder().encode(fill.repeat(16))]);
}

/**
 * A synthetic epub of AO3 work `workId` whose one chapter shows each of `images`, by file
 * name, as an `img`. Each is a manifest item of its own, so two names may hold the same bytes.
 */
export function epubWithImages(
  workId: number,
  images: Record<string, { mediaType: string; data: Uint8Array }>,
  pseud?: string,
): Uint8Array {
  const body = Object.keys(images)
    .map((name) => `<p>pic <img src="images/${name}" alt="${name}"/></p>`)
    .join("");
  return ao3Epub({
    workId,
    pseud,
    files: [{ name: "pics_split_001.xhtml", body: `<div id="chapters">${body}</div>` }],
    extraManifest: Object.entries(images).map(([name, i]) => ({
      href: `images/${name}`,
      mediaType: i.mediaType,
      data: i.data,
    })),
  });
}

/** The bytes and content type of the object at `key`, or null. */
export async function bucketObject(
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string | undefined } | null> {
  const object = await env.BUCKET.get(key);
  if (object === null) return null;
  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    contentType: object.httpMetadata?.contentType,
  };
}
