import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chapterPageKey } from "../src/edge-cache";
import app from "../src/index";
import { READ_WINDOW_SECONDS } from "../src/rate-limit";
import { BASE, consoleDuring, fetchW, freshIp, signIn, windowHeadroom } from "./helpers";
import { READ_FULL_LIMIT } from "./limits";

// Runs in the "open" project. This file keeps to AO3 work ids 8812750 to 8812799; the content
// Worker's tests have 8812700 to 8812749. Text is synthetic.
const W = 8812750;
const CACHED = 8812751;
const WARNED = 8812752;
const HIDDEN = 8812753;
const NO_WORK = 8812754;
const TEXT = "RT-CHAPTER-MARKER";

const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const HEADLESS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const seed = async (ao3WorkId: number, extra: Parameters<typeof seedWork>[1] = {}) => {
  const work = await seedWork(db, {
    ao3WorkId,
    chapters: [{ html: `<p>${TEXT}</p>` }, { html: `<p>${TEXT}</p>` }],
    ...extra,
  });
  await putFragments(env.BUCKET, work.fragments);
};

beforeAll(async () => {
  await seed(W);
  await seed(CACHED);
  await seed(WARNED, { tags: [{ type: "warning", name: "Major Character Death" }] });
  await seed(HIDDEN, { status: "hidden", hiddenCause: "moderator" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A limiter standing in for a binding, answering `answers` in turn and then the last for good. */
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

/** A read through the Worker with `bindings` over the deployed ones, and its page. */
async function read(
  path: string,
  bindings: Partial<typeof env>,
  init: RequestInit = {},
): Promise<{ res: Response; body: string }> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${BASE}${path}`, { redirect: "manual", ...init }),
    { ...env, ...bindings },
    ctx,
  );
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, body };
}

const browser = () => ({ "user-agent": BROWSER, "cf-connecting-ip": freshIp() });

/** Bindings that fail any use: a read that got past the throttle would fail with them. */
const noLookups = () => {
  // SAFETY: nothing can be read from it: the handler below throws for every property.
  const gone = new Proxy({} as never, {
    get(_, name) {
      throw new Error(`The throttled read reached ${String(name)}`);
    },
  });
  return { HYPERDRIVE: gone, HYPERDRIVE_CACHED: gone, BUCKET: gone };
};

/** Shows `res` is the throttle's answer, with no text of the work. */
function expectThrottled(res: Response, body: string, label = "") {
  expect(res.status, label).toBe(429);
  expect(res.headers.get("retry-after"), label).toBe(String(READ_WINDOW_SECONDS));
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  expect(res.headers.get("set-cookie"), label).toBeNull();
  expect(body, label).toContain("<h1>Too many requests</h1>");
  expect(body, label).toContain(`Please try again in ${READ_WINDOW_SECONDS} seconds.`);
  expect(body, label).not.toContain(TEXT);
}

describe("24-crawler-and-agent-blocking", () => {
  it("Chapter reads are throttled per IP", async () => {
    // In the edge cache already, so only the throttle can keep this from being served.
    const ip = freshIp();
    const headers = { "user-agent": BROWSER, "cf-connecting-ip": ip };
    const path = `/works/${CACHED}/chapters/1`;
    const first = await read(path, {}, { headers });
    expect(first.res.status).toBe(200);
    expect(first.body).toContain(TEXT);
    expect(await caches.default.match(chapterPageKey(CACHED, 1))).toBeDefined();

    const { limiter } = stubLimiter(false);
    const cacheRead = vi.spyOn(caches.default, "match");
    const { res, body } = await read(path, { READ_CHAPTER_LIMIT: limiter }, { headers });
    expectThrottled(res, body);
    expect(cacheRead).not.toHaveBeenCalled();
  });

  it("Chapter reads are throttled per IP: one client's key, an address or an IPv6 /64", async () => {
    const { limiter, keys } = stubLimiter(true);
    const at = (ip: string) =>
      read(
        `/works/${W}/chapters/1`,
        { READ_CHAPTER_LIMIT: limiter },
        { headers: { "user-agent": BROWSER, "cf-connecting-ip": ip } },
      );
    await at("198.51.100.1");
    await at("198.51.100.1");
    await at("198.51.100.2");
    await at("2001:db8:1:2::a");
    await at("2001:db8:1:2::b");
    await at("2001:db8:1:3::a");
    const [one, again, other, six, sameSlash64, otherSlash64] = keys;
    expect(again).toBe(one);
    expect(other).not.toBe(one);
    expect(sameSlash64).toBe(six);
    expect(otherSlash64).not.toBe(six);
  });

  it("A throttled read costs no lookups, whoever is signed in", async () => {
    const { cookie } = await signIn(`read-throttle-${freshIp()}@example.test`);
    const over = { READ_CHAPTER_LIMIT: stubLimiter(false).limiter };
    const { res, body } = await read(
      `/works/${W}/chapters/1`,
      { ...over, ...noLookups() },
      { headers: { ...browser(), cookie } },
    );
    expectThrottled(res, body);
  });

  it("Entire-work reads have a lower limit: past it, the 429", async () => {
    // The real binding, on a window with time left in it: the limit is the one wrangler.jsonc sets.
    await windowHeadroom(READ_WINDOW_SECONDS);
    const headers = browser();
    const path = `/works/${W}/full`;
    for (let i = 0; i < READ_FULL_LIMIT; i++) {
      const { res } = await read(path, {}, { headers });
      expect(res.status, `read ${i + 1}`).toBe(200);
    }
    const { res, body } = await read(path, {}, { headers });
    expectThrottled(res, body);

    // Another client still reads, and this client's chapters are a limit of their own.
    expect((await read(path, {}, { headers: browser() })).res.status).toBe(200);
    expect((await read(`/works/${W}/chapters/1`, {}, { headers })).res.status).toBe(200);
  });

  it("Each read spends its own limit, whatever it answers", async () => {
    const counted: [string, "chapter" | "full", number][] = [
      [`/works/${W}/chapters/1`, "chapter", 200],
      // The same paths the router decodes.
      [`/works/${W}/chapters/%31`, "chapter", 200],
      [`/works/${W}/%66ull`, "full", 200],
      [`/works/${W}/full`, "full", 200],
      [`/works/${WARNED}/chapters/1`, "chapter", 302],
      [`/works/${WARNED}/full`, "full", 302],
      [`/works/${HIDDEN}/chapters/1`, "chapter", 451],
      [`/works/${HIDDEN}/full`, "full", 451],
      [`/works/${NO_WORK}/chapters/1`, "chapter", 404],
      [`/works/${NO_WORK}/full`, "full", 404],
      [`/works/${W}/chapters/not-a-number`, "chapter", 404],
    ];
    for (const method of ["GET", "HEAD"]) {
      for (const [path, kind, status] of counted) {
        const what = `${method} ${path}`;
        const chapter = stubLimiter(true);
        const full = stubLimiter(true);
        const { res } = await read(
          path,
          { READ_CHAPTER_LIMIT: chapter.limiter, READ_FULL_LIMIT: full.limiter },
          { method, headers: browser() },
        );
        expect(res.status, what).toBe(status);
        expect(chapter.keys.length, what).toBe(kind === "chapter" ? 1 : 0);
        expect(full.keys.length, what).toBe(kind === "full" ? 1 : 0);
      }
    }
  });

  it("What isn't a read counts against no limit", async () => {
    const chapter = stubLimiter(false);
    const full = stubLimiter(false);
    const over = { READ_CHAPTER_LIMIT: chapter.limiter, READ_FULL_LIMIT: full.limiter };
    for (const path of [
      `/works/${W}/chapters?n=1`,
      `/works/${W}/warnings`,
      `/works/${WARNED}/warnings`,
      `/works/${W}`,
      "/",
    ]) {
      const { res } = await read(path, over, { headers: browser() });
      expect(res.status, path).not.toBe(429);
    }
    // Another method isn't a read: it gets what it always got.
    const post = await read(`/works/${W}/full`, over, { method: "POST", headers: browser() });
    expect(post.res.status).not.toBe(429);
    expect(chapter.keys).toEqual([]);
    expect(full.keys).toEqual([]);
  });

  it("Another site can't spend a reader's limits", async () => {
    const chapter = stubLimiter(true);
    const full = stubLimiter(true);
    const limits = { READ_CHAPTER_LIMIT: chapter.limiter, READ_FULL_LIMIT: full.limiter };
    for (const dest of ["image", "iframe", "empty", "script"]) {
      for (const path of [`/works/${W}/chapters/1`, `/works/${W}/full`]) {
        const headers = { ...browser(), "sec-fetch-site": "cross-site", "sec-fetch-dest": dest };
        const { res, body } = await read(path, limits, { headers });
        expect(res.status, `${dest} ${path}`).toBe(403);
        expect(body, `${dest} ${path}`).not.toContain(TEXT);
      }
    }
    expect(chapter.keys).toEqual([]);
    expect(full.keys).toEqual([]);

    // A link from another site that the reader follows is served and counted as usual.
    const followed = { ...browser(), "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" };
    const toChapter = await read(`/works/${W}/chapters/1`, limits, { headers: followed });
    expect(toChapter.res.status).toBe(200);
    expect(toChapter.body).toContain(TEXT);
    expect(chapter.keys).toHaveLength(1);
    const toFull = await read(`/works/${W}/full`, limits, { headers: followed });
    expect(toFull.res.status).toBe(200);
    expect(full.keys).toHaveLength(1);
  });

  it("A refused request counts against no limit", async () => {
    const chapter = stubLimiter(false);
    const full = stubLimiter(false);
    const limits = { READ_CHAPTER_LIMIT: chapter.limiter, READ_FULL_LIMIT: full.limiter };
    const headers = { "user-agent": "python-requests/2.32.3", "cf-connecting-ip": freshIp() };
    for (const path of [`/works/${W}/chapters/1`, `/works/${W}/full`]) {
      expect((await read(path, limits, { headers })).res.status, path).toBe(403);
    }
    expect(chapter.keys).toEqual([]);
    expect(full.keys).toEqual([]);
  });

  it("A failing limiter does not stop reading", async () => {
    const keys: string[] = [];
    const failing: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        throw new TypeError(`limiter refused ${key}`);
      },
    };
    const broken = { READ_CHAPTER_LIMIT: failing, READ_FULL_LIMIT: failing };
    const ip = freshIp();
    const headers = { "user-agent": BROWSER, "cf-connecting-ip": ip };
    const answers: Response[] = [];
    const logged = await consoleDuring(async () => {
      for (const path of [`/works/${W}/chapters/2`, `/works/${W}/full`]) {
        answers.push((await read(path, broken, { headers })).res);
      }
    });
    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    expect(keys).toHaveLength(2);
    const failures = logged.filter((line) => line.includes("Rate limit unavailable"));
    expect(failures).toHaveLength(2);
    const log = logged.join("\n");
    for (const secret of [ip, String(W), ...keys]) expect(log).not.toContain(secret);
  });

  it("Throttled readers recover after the window", async () => {
    // A stand-in for the window passing: the binding's own says yes again. wrangler.jsonc's
    // period is checked in rate-limit.node.test.ts, and the real window isn't worth a minute here.
    const chapter = stubLimiter(false, true);
    const full = stubLimiter(false, true);
    const limits = { READ_CHAPTER_LIMIT: chapter.limiter, READ_FULL_LIMIT: full.limiter };
    for (const path of [`/works/${W}/chapters/1`, `/works/${W}/full`]) {
      const headers = browser();
      expect((await read(path, limits, { headers })).res.status, path).toBe(429);
      expect((await read(path, limits, { headers })).res.status, path).toBe(200);
    }
  });

  it("Browser automation that does not identify itself is served", async () => {
    const headers = { "user-agent": HEADLESS, "cf-connecting-ip": freshIp() };
    const served = await read(`/works/${W}/chapters/1`, {}, { headers });
    expect(served.res.status).toBe(200);
    expect(served.body).toContain(TEXT);
    // A high rate only meets the read throttles, never the refusal.
    const over = { READ_CHAPTER_LIMIT: stubLimiter(false).limiter };
    const { res, body } = await read(`/works/${W}/chapters/1`, over, { headers });
    expectThrottled(res, body);
  });

  it("Refusals are counted by reason: one line for a throttled read", async () => {
    const over = {
      READ_CHAPTER_LIMIT: stubLimiter(false).limiter,
      READ_FULL_LIMIT: stubLimiter(false).limiter,
    };
    const log = vi.spyOn(console, "log");
    for (const path of [`/works/${W}/chapters/1`, `/works/${W}/full`]) {
      log.mockClear();
      await read(path, over, { headers: browser() });
      expect(log.mock.calls, path).toEqual([["refused: read throttle"]]);
    }
    // A read that's served is no refusal.
    log.mockClear();
    await fetchW(`/works/${W}/chapters/1`, { headers: browser() });
    expect(log).not.toHaveBeenCalled();
  });
});
