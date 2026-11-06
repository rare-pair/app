import { describe, expect, it, vi } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import {
  DMCA_WINDOW_SECONDS,
  emailKey,
  ipKey,
  isLimited,
  LOGIN_WINDOW_SECONDS,
  READ_WINDOW_SECONDS,
  REMOVE_WINDOW_SECONDS,
  tooManyRequests,
  SEARCH_WINDOW_SECONDS,
  UPLOAD_WINDOW_SECONDS,
  userKey,
  WAITLIST_WINDOW_SECONDS,
} from "../src/rate-limit";
import {
  DMCA_IP_LIMIT,
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  READ_CHAPTER_LIMIT,
  READ_FULL_LIMIT,
  REMOVE_EMAIL_LIMIT,
  REMOVE_IP_LIMIT,
  SEARCH_IP_LIMIT,
  SEARCH_USER_LIMIT,
  UPLOAD_IP_LIMIT,
  UPLOAD_USER_LIMIT,
  WAITLIST_EMAIL_LIMIT,
  WAITLIST_FLOOR_MIN_MS,
  WAITLIST_IP_LIMIT,
} from "./limits";

/** The sign-in limit's key for a client address, or for a request without one. */
const loginIp = (address: string | null) => ipKey("login", address);

describe("emailKey", () => {
  it("keys an address however it was spelt", async () => {
    const key = await emailKey("login", "reader@example.test");
    expect(await emailKey("login", "  Reader@EXAMPLE.test ")).toBe(key);
    expect(await emailKey("login", "other@example.test")).not.toBe(key);
  });

  it("never carries the address, and differs from an IP key for the same text", async () => {
    const key = await emailKey("login", "reader@example.test");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("reader");
    // Two limits with one value can't share a counter.
    expect(await emailKey("login", "192.0.2.1")).not.toBe(await loginIp("192.0.2.1"));
  });
});

describe("userKey", () => {
  it("keys a user on the id as given, apart from other users and other limits", async () => {
    const key = await userKey("upload", "user-1");
    expect(await userKey("upload", "user-1")).toBe(key);
    expect(await userKey("upload", "User-1")).not.toBe(key);
    expect(await userKey("upload", "user-2")).not.toBe(key);
    expect(await userKey("other", "user-1")).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("user-1");
    // The same text as an IP can't share a counter.
    expect(await userKey("upload", "192.0.2.1")).not.toBe(await ipKey("upload", "192.0.2.1"));
  });
});

describe("isLimited", () => {
  it("is limited only when the binding says the request is over", async () => {
    expect(await isLimited({ limit: async () => ({ success: true }) }, "k")).toBe(false);
    expect(await isLimited({ limit: async () => ({ success: false }) }, "k")).toBe(true);
  });

  it("lets the request through when the binding fails, logging only the error's name", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });
    try {
      const failing = {
        limit: async () => {
          throw new TypeError("limiter down for key 0123abcd");
        },
      };
      expect(await isLimited(failing, "0123abcd")).toBe(false);
      expect(logged).toEqual([["Rate limit unavailable: TypeError"]]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("isLimited without its binding", () => {
  it("fails loudly rather than letting every request through", async () => {
    // As a binding left out of a deploy's config is, whatever Bindings says.
    await expect(isLimited(undefined, "k")).rejects.toThrow("Rate limit binding missing");
  });
});

describe("the rate limits in wrangler.jsonc", () => {
  type Limit = { name: string; namespace_id: string; simple: { limit: number; period: number } };
  const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
  const limits: Limit[] = rawConfig.ratelimits ?? [];

  it("are the limits the tests and Retry-After assume", () => {
    expect(Object.fromEntries(limits.map(({ name, simple }) => [name, simple]))).toEqual({
      LOGIN_IP_LIMIT: { limit: LOGIN_IP_LIMIT, period: LOGIN_WINDOW_SECONDS },
      LOGIN_EMAIL_LIMIT: { limit: LOGIN_EMAIL_LIMIT, period: LOGIN_WINDOW_SECONDS },
      WAITLIST_IP_LIMIT: { limit: WAITLIST_IP_LIMIT, period: WAITLIST_WINDOW_SECONDS },
      WAITLIST_EMAIL_LIMIT: { limit: WAITLIST_EMAIL_LIMIT, period: WAITLIST_WINDOW_SECONDS },
      DMCA_IP_LIMIT: { limit: DMCA_IP_LIMIT, period: DMCA_WINDOW_SECONDS },
      REMOVE_IP_LIMIT: { limit: REMOVE_IP_LIMIT, period: REMOVE_WINDOW_SECONDS },
      REMOVE_EMAIL_LIMIT: { limit: REMOVE_EMAIL_LIMIT, period: REMOVE_WINDOW_SECONDS },
      UPLOAD_USER_LIMIT: { limit: UPLOAD_USER_LIMIT, period: UPLOAD_WINDOW_SECONDS },
      UPLOAD_IP_LIMIT: { limit: UPLOAD_IP_LIMIT, period: UPLOAD_WINDOW_SECONDS },
      SEARCH_IP_LIMIT: { limit: SEARCH_IP_LIMIT, period: SEARCH_WINDOW_SECONDS },
      SEARCH_USER_LIMIT: { limit: SEARCH_USER_LIMIT, period: SEARCH_WINDOW_SECONDS },
      READ_CHAPTER_LIMIT: { limit: READ_CHAPTER_LIMIT, period: READ_WINDOW_SECONDS },
      READ_FULL_LIMIT: { limit: READ_FULL_LIMIT, period: READ_WINDOW_SECONDS },
    });
  });

  it("let two users each spend half the upload IP limit, which the upload test relies on", () => {
    expect(UPLOAD_IP_LIMIT % 2).toBe(0);
    expect(UPLOAD_IP_LIMIT / 2).toBeLessThanOrEqual(UPLOAD_USER_LIMIT);
  });

  it("set the wait list's response-time floor no lower than the least the design allows", () => {
    const floor = Number(rawConfig.vars?.WAITLIST_FLOOR_MS);
    expect(floor).toBeGreaterThanOrEqual(WAITLIST_FLOOR_MIN_MS);
  });

  it("each have their own namespace, so none shares another's counters", () => {
    // A namespace_id is account-wide, so the content Worker's can't repeat one of these.
    const content: Limit[] =
      experimental_readRawConfig({ config: "../content/wrangler.jsonc" }).rawConfig.ratelimits ?? [];
    expect(content.map((limit) => limit.name)).toEqual(["ORIGINAL_LIMIT"]);
    const namespaces = [...limits, ...content].map((limit) => limit.namespace_id);
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it("Entire-work reads have a lower limit", () => {
    const limitOf = (name: string) => limits.find((limit) => limit.name === name)?.simple.limit;
    expect(limitOf("READ_CHAPTER_LIMIT")).toBe(120);
    expect(limitOf("READ_FULL_LIMIT")).toBe(10);
    expect(limitOf("READ_FULL_LIMIT")).toBeLessThan(limitOf("READ_CHAPTER_LIMIT") ?? 0);
  });

  it("Original downloads are throttled per IP: 10 a minute on the content Worker", () => {
    const content: Limit[] =
      experimental_readRawConfig({ config: "../content/wrangler.jsonc" }).rawConfig.ratelimits ?? [];
    expect(content[0]?.simple).toEqual({ limit: 10, period: 60 });
  });
});

describe("tooManyRequests", () => {
  it("is a 429 whose Retry-After and page say the same whole seconds", async () => {
    const res = tooManyRequests(60);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("<h1>Too many requests</h1>");
    expect(html).toContain("Please try again in 60 seconds.");
  });

  it("asks for a wait of at least one whole second", async () => {
    for (const [seconds, header, text] of [
      [0, "1", "1 second."],
      [1, "1", "1 second."],
      [12.5, "13", "13 seconds."],
    ] as const) {
      const res = tooManyRequests(seconds);
      expect(res.headers.get("retry-after")).toBe(header);
      expect(await res.text()).toContain(`Please try again in ${text}`);
    }
  });
});
