import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import handler, { type Env } from "../src/index";

// SAFETY: the test env is the bindings wrangler.jsonc declares, which Env describes.
const E = env as Env;
// SAFETY: the default export is the Worker under test, loaded from wrangler.jsonc's main.
const worker = (exports as any).default as Fetcher;
const ORIGIN = "https://content.rarepair.fans";

// This file keeps to AO3 work ids 8812600 to 8812699. Bytes are synthetic.
const W = 8812600;
const REMOVED = 8812601;
const CACHED = 8812602;
const NO_WORK = 8812603;
const HIDDEN = 8812604;
const NO_R2 = 8812605;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);
const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 5, 6, 7, 8]);

const CRAWLER = {
  "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
};
const SIGNED = { "signature-agent": '"https://agent.example"' };
const DECLARED: Record<string, string>[] = [CRAWLER, SIGNED];

const imageOf = (ao3WorkId: number) => `works/${ao3WorkId}/img/${"a".repeat(64)}`;

let original = "";
let cachedOriginal = "";
let removedOriginal = "";

beforeAll(async () => {
  const db = createDb({ connectionString: E.HYPERDRIVE.connectionString, max: 1 });
  try {
    const live = await seedWork(db, { ao3WorkId: W });
    const cached = await seedWork(db, { ao3WorkId: CACHED });
    const removed = await seedWork(db, { ao3WorkId: REMOVED, status: "removed" });
    await seedWork(db, { ao3WorkId: HIDDEN, status: "hidden", hiddenCause: "moderator" });
    await seedWork(db, { ao3WorkId: NO_R2 });
    original = `originals/${live.uploadId}.epub`;
    cachedOriginal = `originals/${cached.uploadId}.epub`;
    removedOriginal = `originals/${removed.uploadId}.epub`;
  } finally {
    await db.destroy();
  }
  for (const key of [imageOf(W), imageOf(CACHED), imageOf(REMOVED)]) {
    await E.BUCKET.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
  }
  for (const key of [original, cachedOriginal, removedOriginal]) {
    await E.BUCKET.put(key, EPUB);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A request through the Worker's entry, waiting for its cache write. */
async function request(key: string, init: RequestInit = {}, bindings: Env = E) {
  const pending: Promise<unknown>[] = [];
  // SAFETY: the Worker calls only waitUntil on its context.
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
  const res = await handler.fetch(new Request(`${ORIGIN}/${key}`, init), bindings, ctx);
  const body = new Uint8Array(await res.arrayBuffer());
  await Promise.all(pending);
  return { res, body };
}

/** Bindings that fail any request touching them: Postgres, and R2 for a read or a write. */
// SAFETY: nothing can be read from it: the handler below throws for every property.
const noBindings = new Proxy({} as Env, {
  get(_, name) {
    throw new Error(`The refusal reached ${String(name)}`);
  },
});

describe("24-crawler-and-agent-blocking", () => {
  it("Declared automated clients are refused originals and images", async () => {
    // Two files a reader has already put in the data centre's cache.
    await caches.default.delete(`${ORIGIN}/${imageOf(CACHED)}`);
    await caches.default.delete(`${ORIGIN}/${cachedOriginal}`);
    expect((await request(imageOf(CACHED))).res.status).toBe(200);
    expect((await request(cachedOriginal)).res.status).toBe(200);
    const cacheRead = vi.spyOn(caches.default, "match");
    const cacheWrite = vi.spyOn(caches.default, "put");

    const uncached = [imageOf(W), original];
    const answers = [
      imageOf(CACHED),
      cachedOriginal,
      ...uncached,
      // A file that doesn't exist, or was removed, and any other path on this host.
      imageOf(NO_WORK),
      "originals/no-such-upload.epub",
      imageOf(REMOVED),
      removedOriginal,
      imageOf(HIDDEN),
      "",
      "about",
      "works/8812600/chapters",
      `${imageOf(W)}?v=2`,
    ];
    for (const headers of DECLARED) {
      for (const key of answers) {
        for (const method of ["GET", "HEAD", "POST"]) {
          const what = `${JSON.stringify(headers)} ${method} /${key}`;
          const { res, body } = await request(key, { method, headers }, noBindings);
          expect(res.status, what).toBe(403);
          expect(body.byteLength, what).toBe(0);
          expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
          expect(res.headers.get("cache-control"), what).toBe("no-store");
          expect(res.headers.has("set-cookie"), what).toBe(false);
        }
      }
    }
    expect(cacheRead).not.toHaveBeenCalled();
    expect(cacheWrite).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    // The refusals stored nothing, and a reader still gets the cached files.
    for (const key of [...uncached, imageOf(NO_WORK), imageOf(REMOVED), removedOriginal]) {
      expect(await caches.default.match(`${ORIGIN}/${key}`), key).toBeUndefined();
    }
    const image = await caches.default.match(`${ORIGIN}/${imageOf(CACHED)}`);
    expect(new Uint8Array(await image!.arrayBuffer())).toEqual(PNG);
    const epub = await caches.default.match(`${ORIGIN}/${cachedOriginal}`);
    expect(new Uint8Array(await epub!.arrayBuffer())).toEqual(EPUB);
    // The object is gone from R2 for this one key, so only its entry can answer this.
    await E.BUCKET.delete(imageOf(CACHED));
    const reader = await request(imageOf(CACHED));
    expect(reader.res.status).toBe(200);
    expect(reader.body).toEqual(PNG);
  });

  it("Content origin refusals log no URL", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    await request(imageOf(W), { headers: { ...CRAWLER, "cf-connecting-ip": "203.0.113.7" } });
    expect(log.mock.calls).toEqual([["refused: crawler list"]]);
    expect(error).not.toHaveBeenCalled();
  });

  it("robots.txt keeps crawlers off the content origin", async () => {
    for (const headers of [{}, ...DECLARED]) {
      const what = JSON.stringify(headers);
      const log = vi.spyOn(console, "log");
      const { res, body } = await request("robots.txt", { headers }, noBindings);
      expect(res.status, what).toBe(200);
      expect(res.headers.get("content-type"), what).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
      expect(res.headers.get("cache-control"), what).toBe("public, max-age=3600");
      expect(res.headers.has("set-cookie"), what).toBe(false);
      expect(new TextDecoder().decode(body), what).toBe(
        "User-agent: *\nDisallow: /\nContent-Signal: search=no, ai-input=no, ai-train=no\n",
      );
      expect(log, what).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("Exempt paths are still served", async () => {
    for (const headers of DECLARED) {
      for (const method of ["GET", "HEAD"]) {
        const res = await worker.fetch(`${ORIGIN}/robots.txt`, { method, headers });
        expect(res.status, `${method} /robots.txt`).toBe(200);
        await res.arrayBuffer();
      }
      // Nothing else is exempt: another method, a query string, a slash after, another spelling.
      for (const key of ["robots.txt?x", "robots.txt/", "%72obots.txt", "robots.txt/x"]) {
        const { res } = await request(key, { headers }, noBindings);
        expect(res.status, key).toBe(403);
      }
      const post = await request("robots.txt", { method: "POST", headers }, noBindings);
      expect(post.res.status).toBe(403);
    }
    // For anyone else those are what they always were: not a file here.
    for (const key of ["robots.txt?x", "robots.txt/", "%72obots.txt"]) {
      expect((await request(key)).res.status, key).toBe(404);
    }
    expect((await request("robots.txt", { method: "POST" })).res.status).toBe(405);
  });

  it("Another site can't spend a reader's limits", async () => {
    const embed = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" };
    const followedLink = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" };
    await caches.default.delete(`${ORIGIN}/${original}`);
    await caches.default.delete(`${ORIGIN}/${imageOf(W)}`);

    const refused = await request(original, { headers: embed }, noBindings);
    expect(refused.res.status).toBe(403);
    expect(refused.body.byteLength).toBe(0);
    expect(refused.res.headers.get("cache-control")).toBe("no-store");
    expect(refused.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await caches.default.match(`${ORIGIN}/${original}`)).toBeUndefined();

    const followed = await request(original, { headers: followedLink });
    expect(followed.res.status).toBe(200);
    expect(followed.body).toEqual(EPUB);

    // Once cached too: the check comes before the cache.
    const refusedOnceCached = await request(original, { headers: embed }, noBindings);
    expect(refusedOnceCached.res.status).toBe(403);
    expect(refusedOnceCached.body.byteLength).toBe(0);

    const image = await request(imageOf(W), { headers: embed });
    expect(image.res.status).toBe(200);
    expect(image.body).toEqual(PNG);
  });

  it("Every response asks not to be indexed or used", async () => {
    const TAG = "noindex, noarchive, noai, noimageai";
    const down: Pick<R2Bucket, "get"> = { get: () => Promise.reject(new Error("R2 unavailable")) };
    // SAFETY: the Worker calls only BUCKET.get. A read that fails answers 503, so a 200 is a hit.
    const noR2 = { BUCKET: down as R2Bucket, HYPERDRIVE: E.HYPERDRIVE };
    await caches.default.delete(`${ORIGIN}/${imageOf(W)}`);
    await caches.default.delete(`${ORIGIN}/${original}`);
    for (const key of [imageOf(W), original]) {
      const miss = await request(key);
      expect(miss.res.status, key).toBe(200);
      expect(miss.res.headers.get("x-robots-tag"), `miss ${key}`).toBe(TAG);
      // An entry stored before this shipped has no such header: the hit carries it all the same.
      await caches.default.put(
        `${ORIGIN}/${key}`,
        new Response(miss.body, { headers: { "Cache-Control": "public, max-age=43200" } }),
      );
      const hit = await request(key, {}, noR2);
      expect(hit.res.status, key).toBe(200);
      expect(hit.res.headers.get("x-robots-tag"), `hit ${key}`).toBe(TAG);
      const head = await request(key, { method: "HEAD" });
      expect(head.res.headers.get("x-robots-tag"), `HEAD ${key}`).toBe(TAG);
    }

    const others: [string, number, Awaited<ReturnType<typeof request>>][] = [
      ["refusal", 403, await request(imageOf(W), { headers: CRAWLER })],
      ["robots.txt", 200, await request("robots.txt")],
      ["no such path", 404, await request("about")],
      ["removed file", 404, await request(imageOf(REMOVED))],
      ["hidden file", 451, await request(imageOf(HIDDEN))],
      ["method", 405, await request(imageOf(W), { method: "POST" })],
      ["failed read", 503, await request(imageOf(NO_R2), {}, noR2)],
    ];
    for (const [what, status, { res }] of others) {
      expect(res.status, what).toBe(status);
      expect(res.headers.get("x-robots-tag"), what).toBe(TAG);
    }
  });

  it("Refusals are counted by reason", async () => {
    const log = vi.spyOn(console, "log");
    const cases: [string, Record<string, string>, string][] = [
      ["refused: signature", SIGNED, imageOf(W)],
      ["refused: crawler list", CRAWLER, original],
      // Announcing itself by both counts once, as the signature it checks first.
      ["refused: signature", { ...SIGNED, ...CRAWLER }, original],
      [
        "refused: cross-site subresource",
        { "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" },
        original,
      ],
    ];
    for (const [line, headers, key] of cases) {
      log.mockClear();
      await request(key, { headers }, noBindings);
      expect(log.mock.calls, line).toEqual([[line]]);
    }
    // A request that is served, or answered any other way, is no refusal.
    log.mockClear();
    await request(imageOf(W));
    await request("about");
    await request("robots.txt", { headers: CRAWLER });
    expect(log).not.toHaveBeenCalled();
  });

  it("Refusals store nothing about the client", async () => {
    const headers = { ...CRAWLER, "cf-connecting-ip": "203.0.113.7" };
    // noBindings throws on any use of the database or the bucket, so a read or write of either
    // would fail this. The Worker has no KV.
    for (const key of [imageOf(W), original, imageOf(NO_WORK), "about"]) {
      expect((await request(key, { headers }, noBindings)).res.status, key).toBe(403);
    }
    const crossSite = { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" };
    expect((await request(original, { headers: crossSite }, noBindings)).res.status).toBe(403);
  });

  it("The app adds no challenge", async () => {
    const CHROME =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const expected: [string, Uint8Array][] = [
      [imageOf(W), PNG],
      [original, EPUB],
    ];
    for (const [key, bytes] of expected) {
      await caches.default.delete(`${ORIGIN}/${key}`);
      const { res, body } = await request(key, { headers: { "user-agent": CHROME } });
      expect(res.status, key).toBe(200);
      expect(body, key).toEqual(bytes);
      expect(res.headers.get("content-type") ?? "", key).not.toMatch(/html/);
      expect(res.headers.has("set-cookie"), key).toBe(false);
    }
  });
});
