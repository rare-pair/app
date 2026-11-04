import { createDb, type Database } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env, exports } from "cloudflare:workers";
import type { Kysely } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import handler, { type Env } from "../src/index";

// SAFETY: the test env is the bindings wrangler.jsonc declares, which Env describes.
const E = env as Env;
// SAFETY: the default export is the Worker under test, loaded from wrangler.jsonc's main.
const worker = (exports as any).default as Fetcher;
const ORIGIN = "https://content.rarepair.fans";

// Synthetic bytes only: a PNG signature, and an arbitrary blob standing in for an epub.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7, 6]);

const IMAGE_KEY =
  "works/42900/img/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const MISSING_IMAGE_KEY = "works/42900/img/" + "0".repeat(64);
// The live work these keys belong to (AO3 ids 42900-42999 are this file's). The original's key
// names the work's upload, which the database picks, so it is set once the work is seeded.
const WORK_AO3_ID = 42900;
let ORIGINAL_KEY = "";

/** Runs `fn` with a Kysely on the test database, through the Worker's Hyperdrive. */
async function withDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDb({ connectionString: E.HYPERDRIVE.connectionString, max: 1 });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

let liveWork: { workId: string; uploadId: string };
beforeAll(async () => {
  liveWork = await withDb((db) => seedWork(db, { ao3WorkId: WORK_AO3_ID }));
  ORIGINAL_KEY = `originals/${liveWork.uploadId}.epub`;
});

// An ExecutionContext that keeps what the Worker hands waitUntil, so a test can wait for it.
function collectingCtx() {
  const pending: Promise<unknown>[] = [];
  // SAFETY: the Worker calls only waitUntil on its context.
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
  return { ctx, settled: () => Promise.all(pending) };
}

// A bucket that counts reads and answers from the test's local R2.
function countingBucket() {
  const counter = { reads: 0 };
  const bucket: Pick<R2Bucket, "get"> = {
    get: (key: string) => {
      counter.reads++;
      return E.BUCKET.get(key);
    },
  };
  // SAFETY: the Worker calls only BUCKET.get.
  return { env: { BUCKET: bucket as R2Bucket, HYPERDRIVE: E.HYPERDRIVE }, counter };
}

// Fetches through the Worker's entry as the runtime would, waiting for its cache write.
async function viaHandler(env: Env, url: string, init: RequestInit = {}) {
  const { ctx, settled } = collectingCtx();
  const res = await handler.fetch(new Request(url, init), env, ctx);
  const body = new Uint8Array(await res.arrayBuffer());
  await settled();
  return { res, body };
}

async function waitForEntry(key: string) {
  for (let i = 0; i < 50; i++) {
    const hit = await caches.default.match(`${ORIGIN}/${key}`);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 40));
  }
  return undefined;
}

// A plain GET through the Worker. Its cache write runs after the response, out of the
// test's reach, so a 200 waits for the entry to land: no later step races a late put.
async function get(key: string, init: RequestInit = {}) {
  const res = await worker.fetch(`${ORIGIN}/${key}`, init);
  const plain = (init.method ?? "GET") === "GET" && !new Headers(init.headers).has("range");
  if (res.status === 200 && plain) {
    await res.clone().arrayBuffer();
    await waitForEntry(key);
  }
  return res;
}

// The Worker's cache outlives a test, and its keys are shared across the file: a test that
// changes what a key holds first drops the entries it could be answered from.
async function uncache(...keys: string[]) {
  for (const key of keys) await caches.default.delete(`${ORIGIN}/${key}`);
}

async function seed() {
  await uncache(IMAGE_KEY, ORIGINAL_KEY, MISSING_IMAGE_KEY);
  await E.BUCKET.put(IMAGE_KEY, PNG, { httpMetadata: { contentType: "image/png" } });
  await E.BUCKET.put(ORIGINAL_KEY, EPUB, { httpMetadata: { contentType: "application/epub+zip" } });
}

describe("09-content-origin", () => {
  it("Content origin sets no cookies", async () => {
    await seed();
    for (const key of [IMAGE_KEY, ORIGINAL_KEY]) {
      const res = await get(key, { headers: { cookie: "session=abc" } });
      expect(res.status).toBe(200);
      expect(res.headers.has("set-cookie")).toBe(false);
      await res.arrayBuffer();
    }
  });

  it("Responses forbid content sniffing", async () => {
    await seed();
    const responses = [
      await get(IMAGE_KEY),
      await get(ORIGINAL_KEY),
      await get(MISSING_IMAGE_KEY),
      await get("about"),
    ];
    for (const res of responses) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await res.arrayBuffer();
    }
  });

  it("Images and downloads are cached as immutable", async () => {
    await seed();
    for (const key of [IMAGE_KEY, ORIGINAL_KEY]) {
      const res = await get(key);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable, s-maxage=43200",
      );
      await res.arrayBuffer();
    }
    // A miss is not cached as immutable: the key may be written later.
    const miss = await get(MISSING_IMAGE_KEY);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("no-store");
  });

  it("Original epub downloads as an attachment", async () => {
    await seed();
    const res = await get(ORIGINAL_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-type")).toBe("application/epub+zip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(EPUB);
  });

  it("Original epub is never displayed inline", async () => {
    // Stored metadata is not trusted: an object written with an HTML type and an
    // inline disposition still downloads as an epub attachment.
    await uncache(ORIGINAL_KEY);
    await E.BUCKET.put(ORIGINAL_KEY, EPUB, {
      httpMetadata: { contentType: "text/html", contentDisposition: "inline" },
    });
    for (const method of ["GET", "HEAD"]) {
      const res = await get(ORIGINAL_KEY, { method });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe("attachment");
      expect(res.headers.get("content-type")).toBe("application/epub+zip");
      await res.arrayBuffer();
    }
  });

  it("Content origin only serves images and original downloads", async () => {
    await seed();
    // Things that exist in the bucket but are not images or originals.
    const html = new TextEncoder().encode("<p>x</p>");
    const fragment = "works/42900/01J9ZQ4K7M3XYV8T2W5R6N0B1C/1.html";
    await E.BUCKET.put(fragment, html, { httpMetadata: { contentType: "text/html" } });
    await E.BUCKET.put("uploads/01J9ZQ4K7M3XYV8T2W5R6N0B1C", EPUB);
    await E.BUCKET.put("index.html", html, { httpMetadata: { contentType: "text/html" } });
    await E.BUCKET.put("works/42900/img/.hidden", PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    await E.BUCKET.put("originals/.hidden", EPUB);
    // Image keys that are not a SHA-256 hex digest, so not versioned by their key.
    const unversioned = ["works/42900/img/cover.png", `works/42900/img/${"A".repeat(64)}`];
    for (const key of unversioned) {
      await E.BUCKET.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
    }
    const refused = [
      ...unversioned,
      // Stored keys asked for with a query string: a second URL a purge would miss.
      `${IMAGE_KEY}?v=2`,
      `${ORIGINAL_KEY}?x=1`,
      `${ORIGINAL_KEY}?`,
      fragment,
      "uploads/01J9ZQ4K7M3XYV8T2W5R6N0B1C",
      "index.html",
      "",
      "works/42900/work",
      "works/abc/img/x",
      // A leading zero would be a second spelling of the work, and a second cache key.
      `works/0${WORK_AO3_ID}/img/${"0".repeat(64)}`,
      "works/42900/img/a/b",
      "works/42900/img/",
      "works/42900/img/..%2f01J9ZQ4K7M3XYV8T2W5R6N0B1C%2f1.html",
      "works/42900/img/%2e%2e",
      // Reaches the Worker as is (no dot segment to resolve), so the regex refuses it.
      "works/42900/img/.hidden",
      "originals/.hidden",
      "originals/",
      "originals/a/b",
      `/${ORIGINAL_KEY}`,
    ];
    for (const key of refused) {
      const res = await get(key);
      expect(res.status, key).toBe(404);
      expect(res.headers.get("content-type") ?? "", key).not.toMatch(/html/);
      expect(await res.text(), key).toBe("");
    }

    // An image whose stored type is HTML is not served as HTML.
    await uncache(IMAGE_KEY);
    await E.BUCKET.put(IMAGE_KEY, html, { httpMetadata: { contentType: "text/html" } });
    const image = await get(IMAGE_KEY);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("application/octet-stream");
    await image.arrayBuffer();

    // A stored image type is kept for real images.
    await uncache(IMAGE_KEY);
    await E.BUCKET.put(IMAGE_KEY, PNG, { httpMetadata: { contentType: "image/png" } });
    const png = await get(IMAGE_KEY);
    expect(png.headers.get("content-type")).toBe("image/png");
    await png.arrayBuffer();
  });
});

describe("19-surge-controls-and-quotas", () => {
  it("Content origin is edge-cached", async () => {
    await seed();
    for (const key of [IMAGE_KEY, ORIGINAL_KEY]) {
      const res = await get(key);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable, s-maxage=43200",
      );
      await res.arrayBuffer();
    }
  });
});

// Behaviour no scenario case names, but the content protocol and the notes' defaults do.
describe("content Worker", () => {
  it("HEAD answers with the headers and no body", async () => {
    await seed();
    const res = await get(IMAGE_KEY, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, s-maxage=43200",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("");
  });

  it("A 404 carries the common headers and no body, on GET and HEAD", async () => {
    await seed();
    await E.BUCKET.put("index.html", new TextEncoder().encode("<p>x</p>"));
    // A refused path and a well-formed key that is not in the bucket.
    for (const key of ["index.html", MISSING_IMAGE_KEY]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await get(key, { method, headers: { cookie: "session=abc" } });
        expect(res.status, `${method} ${key}`).toBe(404);
        expect(res.headers.get("cache-control"), `${method} ${key}`).toBe("no-store");
        expect(res.headers.get("x-content-type-options"), `${method} ${key}`).toBe("nosniff");
        expect(res.headers.has("set-cookie"), `${method} ${key}`).toBe(false);
        expect(await res.text(), `${method} ${key}`).toBe("");
      }
    }
  });

  it("Methods other than GET and HEAD are refused", async () => {
    await seed();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get(IMAGE_KEY, { method, body: method === "DELETE" ? undefined : "x" });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
      expect(res.headers.get("cache-control"), method).toBe("no-store");
      expect(res.headers.get("x-content-type-options"), method).toBe("nosniff");
      expect(res.headers.has("set-cookie"), method).toBe(false);
      await res.arrayBuffer();
    }
    // The bucket is untouched.
    expect(await E.BUCKET.head(IMAGE_KEY)).not.toBeNull();
  });

  it("A failed R2 read is an empty 503 with the common headers", async () => {
    // Miniflare's bucket can't be made to fail, so this one case hands the Worker's
    // fetch entry a bucket whose read rejects.
    const bucket: Pick<R2Bucket, "get"> = {
      get: () => Promise.reject(new Error("R2 unavailable")),
    };
    // SAFETY: the Worker calls only BUCKET.get on this path.
    const failing = { BUCKET: bucket as R2Bucket, HYPERDRIVE: E.HYPERDRIVE };
    for (const method of ["GET", "HEAD"]) {
      const res = await handler.fetch(
        new Request(`${ORIGIN}/${IMAGE_KEY}`, { method }),
        failing,
        collectingCtx().ctx,
      );
      expect(res.status, method).toBe(503);
      expect(res.headers.get("cache-control"), method).toBe("no-store");
      expect(res.headers.get("x-content-type-options"), method).toBe("nosniff");
      expect(res.headers.has("set-cookie"), method).toBe(false);
      expect(res.headers.get("content-type") ?? "", method).not.toMatch(/html/);
      expect(await res.text(), method).toBe("");
    }
  });

  it("A key deleted from R2 is no longer served", async () => {
    await seed();
    const before = await get(IMAGE_KEY);
    expect(before.status).toBe(200);
    await before.arrayBuffer();
    await uncache(IMAGE_KEY, ORIGINAL_KEY);
    await E.BUCKET.delete([IMAGE_KEY, ORIGINAL_KEY]);
    for (const key of [IMAGE_KEY, ORIGINAL_KEY]) {
      const res = await get(key);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    }
  });
});

describe("edge cache (#513)", () => {
  it("A repeat request is served from the cache without an R2 read", async () => {
    await seed();
    const { env: counted, counter } = countingBucket();
    const first = await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`);
    expect(first.res.status).toBe(200);
    expect(counter.reads).toBe(1);
    const second = await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`);
    expect(counter.reads).toBe(1);
    expect(second.res.status).toBe(200);
    expect(second.body).toEqual(PNG);
    expect(second.res.headers.get("content-type")).toBe("image/png");
    expect(second.res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, s-maxage=43200",
    );
    expect(second.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(second.res.headers.has("set-cookie")).toBe(false);
  });

  it("A cached original is still an attachment and never html", async () => {
    await seed();
    const { env: counted, counter } = countingBucket();
    await viaHandler(counted, `${ORIGIN}/${ORIGINAL_KEY}`);
    const hit = await viaHandler(counted, `${ORIGIN}/${ORIGINAL_KEY}`);
    expect(counter.reads).toBe(1);
    expect(hit.body).toEqual(EPUB);
    expect(hit.res.headers.get("content-disposition")).toBe("attachment");
    expect(hit.res.headers.get("content-type")).toBe("application/epub+zip");
    expect(hit.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(hit.res.headers.has("set-cookie")).toBe(false);
  });

  it("Through the Worker, a repeat request is answered after the object is gone", async () => {
    await seed();
    const first = await get(IMAGE_KEY);
    await first.arrayBuffer();
    expect(await waitForEntry(IMAGE_KEY)).toBeDefined();
    await E.BUCKET.delete(IMAGE_KEY);
    const again = await get(IMAGE_KEY);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG);
  });

  // Proves only that the key is the bare URL (the one a purge by URL names for originals,
  // and under the prefix purge names for images): not that Cloudflare's purge reaches it.
  it("The entry sits under exactly the request URL, and deleting it re-reads R2", async () => {
    await seed();
    for (const key of [IMAGE_KEY, ORIGINAL_KEY]) {
      const { env: counted, counter } = countingBucket();
      await viaHandler(counted, `${ORIGIN}/${key}`);
      expect(await caches.default.match(`${ORIGIN}/${key}`), key).toBeDefined();
      expect(await caches.default.delete(`${ORIGIN}/${key}`), key).toBe(true);
      const after = await viaHandler(counted, `${ORIGIN}/${key}`);
      expect(counter.reads, key).toBe(2);
      expect(after.res.status, key).toBe(200);
      await caches.default.delete(`${ORIGIN}/${key}`);
      await E.BUCKET.delete(key);
      const gone = await viaHandler(counted, `${ORIGIN}/${key}`);
      expect(gone.res.status, key).toBe(404);
    }
  });

  it("HEAD is neither answered from nor written to the cache", async () => {
    await seed();
    const { env: counted, counter } = countingBucket();
    const head = await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`, { method: "HEAD" });
    expect(head.res.status).toBe(200);
    expect(await caches.default.match(`${ORIGIN}/${IMAGE_KEY}`)).toBeUndefined();
    await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`);
    const headAgain = await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`, { method: "HEAD" });
    expect(headAgain.res.status).toBe(200);
    expect(counter.reads).toBe(3);
  });

  it("Error responses are not cached", async () => {
    await seed();
    const miss = await viaHandler(E, `${ORIGIN}/${MISSING_IMAGE_KEY}`);
    expect(miss.res.status).toBe(404);
    expect(await caches.default.match(`${ORIGIN}/${MISSING_IMAGE_KEY}`)).toBeUndefined();
    await E.BUCKET.put(MISSING_IMAGE_KEY, PNG, { httpMetadata: { contentType: "image/png" } });
    const later = await viaHandler(E, `${ORIGIN}/${MISSING_IMAGE_KEY}`);
    expect(later.res.status).toBe(200);
    await uncache(MISSING_IMAGE_KEY);
    await E.BUCKET.delete(MISSING_IMAGE_KEY);

    const post = await viaHandler(E, `${ORIGIN}/${IMAGE_KEY}`, { method: "POST", body: "x" });
    expect(post.res.status).toBe(405);
    expect(await caches.default.match(`${ORIGIN}/${IMAGE_KEY}`)).toBeUndefined();

    const bucket: Pick<R2Bucket, "get"> = { get: () => Promise.reject(new Error("down")) };
    // SAFETY: the Worker calls only BUCKET.get on this path.
    const failing = { BUCKET: bucket as R2Bucket, HYPERDRIVE: E.HYPERDRIVE };
    const down = await viaHandler(failing, `${ORIGIN}/${IMAGE_KEY}`);
    expect(down.res.status).toBe(503);
    expect(await caches.default.match(`${ORIGIN}/${IMAGE_KEY}`)).toBeUndefined();
  });

  it("URLs the Worker refuses never get an entry", async () => {
    await seed();
    const refused = [`${IMAGE_KEY}?v=2`, `${ORIGINAL_KEY}?`, "index.html", "works/42900/work"];
    for (const key of refused) {
      const { res } = await viaHandler(E, `${ORIGIN}/${key}`);
      expect(res.status, key).toBe(404);
      expect(await caches.default.match(`${ORIGIN}/${key}`), key).toBeUndefined();
    }
  });

  it("Range and conditional requests bypass the cache", async () => {
    await seed();
    const { env: counted, counter } = countingBucket();
    const ranged = await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`, {
      headers: { range: "bytes=0-3" },
    });
    expect(ranged.res.status).toBe(200);
    expect(ranged.body).toEqual(PNG);
    expect(await caches.default.match(`${ORIGIN}/${IMAGE_KEY}`)).toBeUndefined();

    await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`);
    expect(counter.reads).toBe(2);
    const bypassing: Record<string, string>[] = [
      { range: "bytes=0-3" },
      { "if-none-match": '"x"' },
      { "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT" },
      { "if-match": '"x"' },
      { "if-range": '"x"' },
    ];
    for (const headers of bypassing) {
      const res = await viaHandler(counted, `${ORIGIN}/${IMAGE_KEY}`, { headers });
      expect(res.res.status, JSON.stringify(headers)).toBe(200);
      expect(res.body, JSON.stringify(headers)).toEqual(PNG);
    }
    expect(counter.reads).toBe(7);
  });
});
