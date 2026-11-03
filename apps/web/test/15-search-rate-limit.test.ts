import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { SEARCH_WINDOW_SECONDS } from "../src/rate-limit";
import { BASE, consoleDuring, fetchW, freshIp, signIn, windowHeadroom } from "./helpers";
import { SEARCH_IP_LIMIT, SEARCH_USER_LIMIT } from "./limits";

// SR2's cases: `GET /search` is limited per signed-in user and per client IP, counted before
// the database is opened. A query nothing matches keeps each spent search cheap.

const QUERY = "zzqrlimitprobe";

const search = (headers: Record<string, string> = {}, q = QUERY, extra = "") =>
  fetchW(`/search?q=${encodeURIComponent(q)}${extra}`, {
    headers: { "cf-connecting-ip": freshIp(), ...headers },
  });

/** A new user's session cookie, with the terms accepted. */
const newUser = (name: string) =>
  signIn(`${name}-${crypto.randomUUID().slice(0, 8)}@example.test`, { acceptTerms: true });

/** Spends `count` searches from `headers`' client, each answered 200. */
async function spend(count: number, headers: () => Record<string, string>) {
  for (let i = 0; i < count; i++) {
    expect((await search(headers())).status).toBe(200);
  }
}

/** The 429: the plain page saying the window, `Retry-After` the same, the query's Referrer-Policy. */
async function expectTooManyRequests(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe(String(SEARCH_WINDOW_SECONDS));
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin");
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await res.text();
  expect(html).toContain("Too many requests");
  expect(html).toContain(`Please try again in ${SEARCH_WINDOW_SECONDS} seconds.`);
  expect(html).not.toContain("No works match");
}

describe("15-search", () => {
  it("Search is rate-limited", async () => {
    await windowHeadroom(SEARCH_WINDOW_SECONDS);
    const cookie = await newUser("search-limit");
    // From a new address each time, so only the user's limit can refuse.
    await spend(SEARCH_USER_LIMIT, () => ({ cookie }));

    await expectTooManyRequests(await search({ cookie }));

    // Another user is not held up with them.
    expect((await search({ cookie: await newUser("search-limit-other") })).status).toBe(200);
  });
});

describe("19-surge-controls", () => {
  it("Search is throttled per IP", async () => {
    await windowHeadroom(SEARCH_WINDOW_SECONDS);
    const ip = freshIp();
    await spend(SEARCH_IP_LIMIT, () => ({ "cf-connecting-ip": ip }));

    await expectTooManyRequests(await search({ "cf-connecting-ip": ip }));

    // Another address is not held up with it.
    expect((await search()).status).toBe(200);
  });

  it("A user over their limit doesn't spend the budget of an address others share", async () => {
    await windowHeadroom(SEARCH_WINDOW_SECONDS);
    const ip = freshIp();
    const [noisy, quiet] = [await newUser("search-noisy"), await newUser("search-quiet")];
    await spend(SEARCH_USER_LIMIT, () => ({ cookie: noisy }));
    // More refused requests than the IP has budget left for.
    for (let i = 0; i < SEARCH_IP_LIMIT; i++) {
      expect((await search({ cookie: noisy, "cf-connecting-ip": ip })).status).toBe(429);
    }
    expect((await search({ cookie: quiet, "cf-connecting-ip": ip })).status).toBe(200);
  });

  it("A signed-in search spends the budget of its address too", async () => {
    await windowHeadroom(SEARCH_WINDOW_SECONDS);
    const ip = freshIp();
    const cookie = await newUser("search-shared-ip");
    await spend(SEARCH_IP_LIMIT, () => ({ cookie, "cf-connecting-ip": ip }));

    await expectTooManyRequests(await search({ "cf-connecting-ip": ip }));
  });

  it("A blank query shows the form and spends no budget", async () => {
    await windowHeadroom(SEARCH_WINDOW_SECONDS);
    const ip = freshIp();
    for (let i = 0; i < SEARCH_IP_LIMIT + 1; i++) {
      expect((await search({ "cf-connecting-ip": ip }, "  ")).status).toBe(200);
    }
    expect((await search({ "cf-connecting-ip": ip })).status).toBe(200);
  });

  it("Each results page spends one", async () => {
    await windowHeadroom(SEARCH_WINDOW_SECONDS);
    const ip = freshIp();
    // Page 2 of nothing is a 404, but it still asked the database, so it counts.
    for (let i = 0; i < SEARCH_IP_LIMIT; i++) {
      expect((await search({ "cf-connecting-ip": ip }, QUERY, "&page=2")).status).toBe(404);
    }
    expect((await search({ "cf-connecting-ip": ip })).status).toBe(429);
  });

  it("Throttling recovers after the window", async () => {
    // The limiter refuses its first call and then allows: the window passing, as the binding
    // sees it. The route keeps no state of its own that could hold the refusal on.
    let calls = 0;
    const recovering: RateLimit = {
      limit: async () => ({ success: calls++ > 0 }),
    };
    const get = async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`${BASE}/search?q=${QUERY}`, {
          headers: { "cf-connecting-ip": freshIp() },
        }),
        { ...env, SEARCH_IP_LIMIT: recovering },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    await expectTooManyRequests(await get());
    expect((await get()).status).toBe(200);
  });

  it("A failing rate limiter lets a search through and logs no user, IP, query or key", async () => {
    const cookie = await newUser("search-limiter-down");
    const keys: string[] = [];
    const failing: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        throw new Error(`limiter refused ${key}`);
      },
    };
    const ip = freshIp();
    let status = 0;
    const logged = await consoleDuring(async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`${BASE}/search?q=${QUERY}`, {
          headers: { "cf-connecting-ip": ip, cookie },
        }),
        { ...env, SEARCH_IP_LIMIT: failing, SEARCH_USER_LIMIT: failing },
        ctx,
      );
      status = res.status;
      await waitOnExecutionContext(ctx);
    });

    expect(status).toBe(200);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(logged.length).toBeGreaterThan(0);
    const log = logged.join("\n");
    for (const secret of [ip, QUERY, "search-limiter-down", ...keys]) {
      expect(log).not.toContain(secret);
    }
  });
});
