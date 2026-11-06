import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import handler, { type Env } from "../src/index";
import wrangler from "../wrangler.jsonc?raw";
import { freshIp } from "./client";

// SAFETY: the test env is the bindings wrangler.jsonc declares, which Env describes.
const E = env as Env;
const ORIGIN = "https://content.rarepair.fans";

// This file keeps to AO3 work ids 8812700 to 8812749; the web Worker's tests have 8812750 to
// 8812799. Bytes are synthetic.
const W = 8812700;
const CACHED = 8812701;

const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const IMAGE = `works/${W}/img/${"b".repeat(64)}`;
// As wrangler.jsonc sets them, so a new period there can't leave Retry-After behind unseen.
const [, ORIGINAL_LIMIT = 0, WINDOW_SECONDS = 0] =
  wrangler.match(/"limit": (\d+), "period": (\d+)/)?.map(Number) ?? [];

let original = "";
let cachedOriginal = "";

beforeAll(async () => {
  const db = createDb({ connectionString: E.HYPERDRIVE.connectionString, max: 1 });
  try {
    original = `originals/${(await seedWork(db, { ao3WorkId: W })).uploadId}.epub`;
    cachedOriginal = `originals/${(await seedWork(db, { ao3WorkId: CACHED })).uploadId}.epub`;
  } finally {
    await db.destroy();
  }
  await E.BUCKET.put(original, EPUB);
  await E.BUCKET.put(cachedOriginal, EPUB);
  await E.BUCKET.put(IMAGE, PNG, { httpMetadata: { contentType: "image/png" } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A limiter standing in for the binding, answering `answers` in turn and then the last for good. */
function stubLimiter(...answers: boolean[]) {
  const keys: string[] = [];
  const limiter: RateLimit = {
    limit: async ({ key }) => {
      keys.push(key);
      return { success: answers[Math.min(keys.length - 1, answers.length - 1)] ?? true };
    },
  };
  return { limiter, keys };
}

/** A request through the Worker's entry, waiting for its cache write. */
async function request(
  key: string,
  init: RequestInit = {},
  limiter: RateLimit = E.ORIGINAL_LIMIT,
  lookups: Partial<Env> = {},
) {
  const pending: Promise<unknown>[] = [];
  // SAFETY: the Worker calls only waitUntil on its context.
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
  const bindings = { ...E, ORIGINAL_LIMIT: limiter, ...lookups };
  const res = await handler.fetch(new Request(`${ORIGIN}/${key}`, init), bindings, ctx);
  const body = new Uint8Array(await res.arrayBuffer());
  await Promise.all(pending);
  return { res, body };
}

/** Bindings that fail any use: a request that got past the throttle would fail with them. */
const noLookups = () => {
  // SAFETY: nothing can be read from it: the handler below throws for every property.
  const gone = new Proxy({} as never, {
    get(_, name) {
      throw new Error(`The throttled read reached ${String(name)}`);
    },
  });
  return { BUCKET: gone, HYPERDRIVE: gone } satisfies Partial<Env>;
};

/** Shows a response is the throttle's: nothing of the file, and nothing to keep. */
function expectThrottled(res: Response, body: Uint8Array, label = "") {
  expect(res.status, label).toBe(429);
  expect(res.headers.get("retry-after"), label).toBe(String(WINDOW_SECONDS));
  expect(body.byteLength, label).toBe(0);
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  expect(res.headers.get("x-robots-tag"), label).toBe("noindex, noarchive, noai, noimageai");
  expect(res.headers.has("set-cookie"), label).toBe(false);
  expect(res.headers.has("content-type"), label).toBe(false);
}

describe("24-crawler-and-agent-blocking", () => {
  it("Original downloads are throttled per IP", async () => {
    // The real binding, on a window with time left in it.
    const left = WINDOW_SECONDS * 1000 - (Date.now() % (WINDOW_SECONDS * 1000));
    if (left < 20_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
    await caches.default.delete(`${ORIGIN}/${original}`);
    const headers = { "cf-connecting-ip": freshIp() };
    for (let i = 0; i < ORIGINAL_LIMIT; i++) {
      expect((await request(original, { headers })).res.status, `read ${i + 1}`).toBe(200);
    }
    const over = await request(original, { headers });
    expectThrottled(over.res, over.body);
    // Another client still downloads.
    const other = await request(original, { headers: { "cf-connecting-ip": freshIp() } });
    expect(other.res.status).toBe(200);
    expect(other.body).toEqual(EPUB);
  });

  it("Original downloads are throttled per IP: by a full or a Range request, cached or not", async () => {
    const { limiter } = stubLimiter(false);
    // One in the data centre's cache, one not.
    await caches.default.delete(`${ORIGIN}/${original}`);
    await caches.default.delete(`${ORIGIN}/${cachedOriginal}`);
    expect(
      (await request(cachedOriginal, { headers: { "cf-connecting-ip": freshIp() } })).res.status,
    ).toBe(200);
    expect(await caches.default.match(`${ORIGIN}/${cachedOriginal}`)).toBeDefined();

    const cacheRead = vi.spyOn(caches.default, "match");
    const cacheWrite = vi.spyOn(caches.default, "put");
    const headersFor: Record<string, string>[] = [
      {},
      { range: "bytes=0-3" },
      { "if-none-match": '"x"' },
    ];
    for (const key of [original, cachedOriginal]) {
      for (const method of ["GET", "HEAD"]) {
        for (const extra of headersFor) {
          const what = `${method} ${key} ${JSON.stringify(extra)}`;
          const headers = { "cf-connecting-ip": freshIp(), ...extra };
          const { res, body } = await request(key, { method, headers }, limiter, noLookups());
          expectThrottled(res, body, what);
        }
      }
    }
    expect(cacheRead).not.toHaveBeenCalled();
    expect(cacheWrite).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await caches.default.match(`${ORIGIN}/${original}`)).toBeUndefined();
  });

  it("Original downloads are throttled per IP: one client's key, an address or an IPv6 /64", async () => {
    const { limiter, keys } = stubLimiter(true);
    for (const ip of [
      "198.51.100.200",
      "198.51.100.200",
      "198.51.100.201",
      "2001:db8:1:2::a",
      "2001:db8:1:2::b",
      "2001:db8:1:3::a",
    ]) {
      await request(original, { headers: { "cf-connecting-ip": ip } }, limiter);
    }
    const [one, again, other, six, sameSlash64, otherSlash64] = keys;
    expect(again).toBe(one);
    expect(other).not.toBe(one);
    expect(sameSlash64).toBe(six);
    expect(otherSlash64).not.toBe(six);
  });

  it("Each original read spends the limit, whatever it answers", async () => {
    const answers: [string, number][] = [
      [original, 200],
      ["originals/no-such-upload.epub", 404],
      [`${original}?v=2`, 404],
    ];
    for (const method of ["GET", "HEAD"]) {
      for (const [key, status] of answers) {
        const { limiter, keys } = stubLimiter(true);
        const headers = { "cf-connecting-ip": freshIp() };
        const { res } = await request(key, { method, headers }, limiter);
        expect(res.status, `${method} ${key}`).toBe(status);
        expect(keys, `${method} ${key}`).toHaveLength(1);
      }
    }
    // Another method isn't a read.
    const { limiter, keys } = stubLimiter(false);
    expect((await request(original, { method: "POST" }, limiter)).res.status).toBe(405);
    expect(keys).toEqual([]);
  });

  it("Images are not throttled", async () => {
    await caches.default.delete(`${ORIGIN}/${IMAGE}`);
    const headers = { "cf-connecting-ip": freshIp() };
    // Past the limit on originals, for one reader on one address, through the real binding.
    for (let i = 0; i <= ORIGINAL_LIMIT; i++) {
      const { res, body } = await request(IMAGE, { headers });
      expect(res.status, `image ${i + 1}`).toBe(200);
      expect(body, `image ${i + 1}`).toEqual(PNG);
    }
    const { limiter, keys } = stubLimiter(false);
    expect((await request(IMAGE, { headers }, limiter)).res.status).toBe(200);
    expect(keys).toEqual([]);
    // Another path on this host isn't throttled either: it's just not a file.
    expect((await request("about", { headers }, limiter)).res.status).toBe(404);
    expect(keys).toEqual([]);
  });

  it("A failing limiter does not stop reading", async () => {
    const keys: string[] = [];
    const failing: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        throw new TypeError(`limiter refused ${key}`);
      },
    };
    const error = vi.spyOn(console, "error");
    const log = vi.spyOn(console, "log");
    const ip = freshIp();
    const { res, body } = await request(original, { headers: { "cf-connecting-ip": ip } }, failing);
    expect(res.status).toBe(200);
    expect(body).toEqual(EPUB);
    expect(keys).toHaveLength(1);
    expect(error.mock.calls).toEqual([["Rate limit unavailable: TypeError"]]);
    expect(log).not.toHaveBeenCalled();
  });

  it("Throttled readers recover after the window", async () => {
    // A stand-in for the window passing: the binding's own says yes again. wrangler.jsonc's period
    // is checked in apps/web/test/rate-limit.node.test.ts.
    const { limiter } = stubLimiter(false, true);
    const headers = { "cf-connecting-ip": freshIp() };
    expect((await request(original, { headers }, limiter)).res.status).toBe(429);
    const next = await request(original, { headers }, limiter);
    expect(next.res.status).toBe(200);
    expect(next.body).toEqual(EPUB);
  });

  it("Another site can't spend a reader's limits", async () => {
    const { limiter, keys } = stubLimiter(true);
    for (const dest of ["image", "iframe", "empty", "script"]) {
      const headers = { "sec-fetch-site": "cross-site", "sec-fetch-dest": dest };
      const { res, body } = await request(original, { headers }, limiter);
      expect(res.status, dest).toBe(403);
      expect(body.byteLength, dest).toBe(0);
    }
    expect(keys).toEqual([]);

    // A link from another site that the reader follows is served and counted as usual.
    const followed = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-dest": "document",
      "cf-connecting-ip": freshIp(),
    };
    const { res, body } = await request(original, { headers: followed }, limiter);
    expect(res.status).toBe(200);
    expect(body).toEqual(EPUB);
    expect(keys).toHaveLength(1);

    // An image embedded by another site is served, and spends nothing.
    const embedded = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" };
    expect((await request(IMAGE, { headers: embedded }, limiter)).res.status).toBe(200);
    expect(keys).toHaveLength(1);
  });

  it("A refused request counts against no limit", async () => {
    const { limiter, keys } = stubLimiter(false);
    const headers = { "user-agent": "python-requests/2.32.3" };
    expect((await request(original, { headers }, limiter)).res.status).toBe(403);
    expect(keys).toEqual([]);
  });

  it("Refusals are counted by reason: one line for a throttled read", async () => {
    const log = vi.spyOn(console, "log");
    const { limiter } = stubLimiter(false);
    await request(original, { headers: { "cf-connecting-ip": "198.51.100.77" } }, limiter);
    expect(log.mock.calls).toEqual([["refused: read throttle"]]);
    // A read that's served is no refusal.
    log.mockClear();
    await request(original, { headers: { "cf-connecting-ip": freshIp() } });
    expect(log).not.toHaveBeenCalled();
  });
});
