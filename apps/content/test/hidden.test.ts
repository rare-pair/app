import { createDb, hideWork, restoreWork, type Database, type HiddenCause } from "@archive/db";
import { seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import handler, { type Env } from "../src/index";

// SAFETY: the test env is the bindings wrangler.jsonc declares, which Env describes.
const E = env as Env;
const ORIGIN = "https://content.rarepair.fans";

// Synthetic bytes only. AO3 work ids 42901-42999 are this file's (content.test.ts has 42900).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7, 6]);

let nextAo3Id = 42901;
const freshAo3Id = () => nextAo3Id++;
const hash = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

async function withDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDb({ connectionString: E.HYPERDRIVE.connectionString, max: 1 });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

function ctxOf() {
  const pending: Promise<unknown>[] = [];
  // SAFETY: the Worker calls only waitUntil on its context.
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
  return { ctx, settled: () => Promise.all(pending) };
}

/** A request through the Worker's entry, waiting for its cache write. */
async function request(key: string, init: RequestInit = {}, env: Env = E) {
  const { ctx, settled } = ctxOf();
  const res = await handler.fetch(new Request(`${ORIGIN}/${key}`, init), env, ctx);
  const body = new Uint8Array(await res.arrayBuffer());
  await settled();
  return { res, body };
}

/** The ways a request can reach bytes: a plain GET, HEAD, a range, and each conditional header. */
const REQUEST_KINDS: { name: string; init: RequestInit }[] = [
  { name: "GET", init: {} },
  { name: "HEAD", init: { method: "HEAD" } },
  { name: "Range", init: { headers: { range: "bytes=0-3" } } },
  { name: "If-None-Match", init: { headers: { "if-none-match": '"x"' } } },
  {
    name: "If-Modified-Since",
    init: { headers: { "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT" } },
  },
  {
    name: "If-Unmodified-Since",
    init: { headers: { "if-unmodified-since": "Wed, 01 Jan 2030 00:00:00 GMT" } },
  },
  { name: "If-Match", init: { headers: { "if-match": '"x"' } } },
  { name: "If-Range", init: { headers: { "if-range": '"x"' } } },
];

async function expectRefused(key: string, status: number, label: string) {
  for (const { name, init } of REQUEST_KINDS) {
    const { res, body } = await request(key, init);
    const what = `${label} ${name}`;
    expect(res.status, what).toBe(status);
    expect(res.headers.get("cache-control"), what).toBe("no-store");
    expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
    expect(res.headers.has("set-cookie"), what).toBe(false);
    expect(res.headers.get("content-type") ?? "", what).not.toMatch(/html/);
    expect(body.byteLength, what).toBe(0);
    expect(await caches.default.match(`${ORIGIN}/${key}`), what).toBeUndefined();
  }
}

async function expectServed(key: string, bytes: Uint8Array, label: string) {
  const { res, body } = await request(key);
  expect(res.status, label).toBe(200);
  expect(body, label).toEqual(bytes);
  await caches.default.delete(`${ORIGIN}/${key}`);
}

/** A work with an image and its original in R2, in the status given. */
async function seeded(status: "live" | "hidden" | "removed", hiddenCause?: HiddenCause) {
  const ao3WorkId = freshAo3Id();
  const work = await withDb((db) => seedWork(db, { ao3WorkId, status, hiddenCause }));
  const image = `works/${ao3WorkId}/img/${hash().slice(0, 64)}`;
  const original = `originals/${work.uploadId}.epub`;
  await E.BUCKET.put(image, PNG, { httpMetadata: { contentType: "image/png" } });
  await E.BUCKET.put(original, EPUB);
  return { ...work, image, original };
}

describe("09-content-origin", () => {
  it("A hidden work's image is refused, whatever the request", async () => {
    for (const cause of ["moderator", "reports", "removal_request"] as const) {
      const w = await seeded("hidden", cause);
      await expectRefused(w.image, 451, `image of a work hidden by ${cause}`);
    }
  });

  it("A hidden work's original is refused, whatever the request", async () => {
    for (const cause of ["moderator", "reports", "removal_request"] as const) {
      const w = await seeded("hidden", cause);
      await expectRefused(w.original, 451, `original of a work hidden by ${cause}`);
    }
  });

  it("A copy cached before a hide is served until it ages out", async () => {
    const w = await seeded("live");
    await expectServed(w.image, PNG, "live image");
    const cached = await request(w.image);
    expect(cached.res.status).toBe(200);
    expect(await caches.default.match(`${ORIGIN}/${w.image}`)).toBeDefined();
    await withDb((db) => hideWork(db, w.workId, "moderator"));
    const stale = await request(w.image);
    expect(stale.res.status).toBe(200);
    expect(stale.body).toEqual(PNG);
    // Ageing out, as the entry's 12 hours do: the entry is gone and the next request is refused.
    await caches.default.delete(`${ORIGIN}/${w.image}`);
    await expectRefused(w.image, 451, "hidden image once uncached");
  });

  it("A refusal names no cause", async () => {
    const w = await seeded("hidden", "removal_request");
    const { res } = await request(w.image);
    const all = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(all).not.toMatch(/removal_request|moderator|reports/);
  });

  it("A restored work's image and original are served again", async () => {
    const w = await seeded("live");
    await expectServed(w.image, PNG, "live image");
    await expectServed(w.original, EPUB, "live original");

    expect(await withDb((db) => hideWork(db, w.workId, "moderator"))).toBe(true);
    await expectRefused(w.image, 451, "hidden image");
    await expectRefused(w.original, 451, "hidden original");

    expect(await withDb((db) => restoreWork(db, w.workId))).toBe(true);
    await expectServed(w.image, PNG, "restored image");
    await expectServed(w.original, EPUB, "restored original");
  });

  it("A removed work's files are a 404, as are unknown works and uploads", async () => {
    const removed = await seeded("removed");
    await expectRefused(removed.image, 404, "removed image");
    await expectRefused(removed.original, 404, "removed original");

    const unknownImage = `works/${freshAo3Id()}/img/${hash().slice(0, 64)}`;
    await E.BUCKET.put(unknownImage, PNG, { httpMetadata: { contentType: "image/png" } });
    await expectRefused(unknownImage, 404, "image of an unknown work");
    // Above int4: the lookup must not fail on it.
    const huge = `works/99999999999/img/${hash().slice(0, 64)}`;
    await E.BUCKET.put(huge, PNG, { httpMetadata: { contentType: "image/png" } });
    await expectRefused(huge, 404, "image of a work id above int4");

    const unknownOriginal = `originals/${crypto.randomUUID()}.epub`;
    await E.BUCKET.put(unknownOriginal, EPUB);
    await expectRefused(unknownOriginal, 404, "original of an unknown upload");
  });

  it("An original whose upload has no work is a 404", async () => {
    const live = await seeded("live");
    const id = crypto.randomUUID();
    await withDb((db) =>
      db
        .insertInto("uploads")
        .values({
          id,
          user_id: live.userId,
          r2_key: `uploads/${id}.epub`,
          sha256: hash(),
          bytes: 1,
          status: "not_ao3",
        })
        .execute(),
    );
    await E.BUCKET.put(`originals/${id}.epub`, EPUB);
    await expectRefused(`originals/${id}.epub`, 404, "refused upload's original");
  });

  it("A held version's original is a 404, though its work is live", async () => {
    const live = await seeded("live");
    const held = await withDb((db) => seedVersion(db, live, { current: false }));
    await E.BUCKET.put(`originals/${held.uploadId}.epub`, EPUB);
    await expectRefused(`originals/${held.uploadId}.epub`, 404, "held version's original");
    await expectServed(live.original, EPUB, "current version's original");
  });

  it("A duplicate upload's original follows its work's status", async () => {
    const live = await seeded("live");
    const id = crypto.randomUUID();
    await withDb((db) =>
      db
        .insertInto("uploads")
        .values({
          id,
          user_id: live.userId,
          r2_key: `uploads/${id}.epub`,
          sha256: hash(),
          bytes: 1,
          status: "duplicate",
          work_id: live.workId,
        })
        .execute(),
    );
    await E.BUCKET.put(`originals/${id}.epub`, EPUB);
    await expectServed(`originals/${id}.epub`, EPUB, "duplicate of a live work");
    await withDb((db) => hideWork(db, live.workId, "moderator"));
    await expectRefused(`originals/${id}.epub`, 451, "duplicate of a hidden work");
  });

  it("No other spelling of a hidden original's key returns its bytes", async () => {
    const hidden = await seeded("hidden", "moderator");
    const id = hidden.uploadId;
    // Each spelling has an object under it in R2, so only a refusal keeps the bytes back.
    const spellings = [
      `originals/${id}.EPUB`,
      `originals/${id}.epub.epub`,
      `originals/${id.toUpperCase()}.epub`,
    ];
    for (const key of spellings) {
      await E.BUCKET.put(key, EPUB);
      const { res, body } = await request(key);
      expect(res.status, key).not.toBe(200);
      expect(body.byteLength, key).toBe(0);
    }
  });

  it("An original's key without .epub is checked the same way", async () => {
    const hidden = await seeded("hidden", "moderator");
    await E.BUCKET.put(`originals/${hidden.uploadId}`, EPUB);
    await expectRefused(`originals/${hidden.uploadId}`, 451, "bare key of a hidden work");
  });
});

/** An env whose Hyperdrive is `hyperdrive`; the Worker reads only its bindings. */
function withHyperdrive(hyperdrive: Pick<Hyperdrive, "connectionString">): Env {
  // SAFETY: the Worker reads only HYPERDRIVE.connectionString of the binding, which both
  // callers provide.
  return { ...E, HYPERDRIVE: hyperdrive } as Env;
}

/** An env that counts the connections the Worker opens: it makes one query on each. */
function countingEnv() {
  const counter = { connections: 0 };
  const env = withHyperdrive({
    get connectionString() {
      counter.connections++;
      return E.HYPERDRIVE.connectionString;
    },
  });
  return { env, counter };
}

describe("19-surge-controls-and-quotas", () => {
  it("A cache hit needs no database read, a miss reads once, and an outage fails closed", async () => {
    const w = await seeded("live");
    const { env: counting, counter } = countingEnv();
    const first = await request(w.image, {}, counting);
    expect(first.res.status).toBe(200);
    expect(counter.connections).toBe(1);

    // The database is gone: the cached copy is still served, a miss is a 503.
    const unreachable = withHyperdrive({
      connectionString: "postgresql://nobody:nobody@127.0.0.1:1/none",
    });
    const hit = await request(w.image, {}, unreachable);
    expect(hit.res.status).toBe(200);
    expect(hit.body).toEqual(PNG);
    const again = await request(w.image, {}, counting);
    expect(again.res.status).toBe(200);
    expect(counter.connections).toBe(1);

    await caches.default.delete(`${ORIGIN}/${w.image}`);
    // Each failed read waits out the connect timeout, so three kinds stand for all.
    for (const key of [w.image, w.original]) {
      for (const { name, init } of REQUEST_KINDS.slice(0, key === w.image ? 3 : 1)) {
        const { res, body } = await request(key, init, unreachable);
        const what = `${name} ${key.split("/")[0]}`;
        expect(res.status, what).toBe(503);
        expect(res.headers.get("cache-control"), what).toBe("no-store");
        expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
        expect(res.headers.has("set-cookie"), what).toBe(false);
        expect(body.byteLength, what).toBe(0);
        expect(await caches.default.match(`${ORIGIN}/${key}`), what).toBeUndefined();
      }
    }
  });

  it("Range and conditional requests and HEAD read the database every time", async () => {
    const w = await seeded("live");
    const { env: counting, counter } = countingEnv();
    await request(w.image, {}, counting);
    counter.connections = 0;
    for (const { init } of REQUEST_KINDS.slice(1)) await request(w.image, init, counting);
    expect(counter.connections).toBe(REQUEST_KINDS.length - 1);
  });
});
