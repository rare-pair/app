import { createDb } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { UPLOAD_WINDOW_SECONDS } from "../src/rate-limit";
import {
  BASE,
  consoleDuring,
  freshIp,
  postLogin,
  signIn as signInAs,
  UPLOAD_TOKEN,
  windowHeadroom,
} from "./helpers";
import { UPLOAD_IP_LIMIT, UPLOAD_USER_LIMIT } from "./limits";

// U5's cases: `POST /uploads` is limited per signed-in user and per client IP, counted
// before the form is read, so a flood costs no body, no Turnstile check and no row.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs a new user in through the Worker, with the terms accepted. */
async function signIn(name: string): Promise<{ userId: string; cookie: string }> {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const cookie = await signInAs(email, { next: "/upload", acceptTerms: true });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { userId: user.id, cookie };
}

/** The upload page's script asking for a URL, from `ip` (new unless given). */
const requestUpload = (cookie: string, token = UPLOAD_TOKEN, ip = freshIp()) =>
  postLogin(
    { size: "1000", "cf-turnstile-response": token },
    { url: "/uploads", headers: { cookie, "cf-connecting-ip": ip } },
  );

const uploadsOf = (userId: string) =>
  db.selectFrom("uploads").select("id").where("user_id", "=", userId).execute();

/**
 * Spends `count` of a limit's requests for the window on requests Turnstile refuses: the limits
 * are counted before the form is read, so they count all the same, and make no row.
 */
async function spend(cookie: string, count: number, ip?: string) {
  for (let i = 0; i < count; i++) {
    expect((await requestUpload(cookie, "a-failing-token", ip)).status).toBe(400);
  }
}

/** The 429: JSON saying the window, `Retry-After` the same, nothing to upload with. */
async function expectTooManyRequests(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe(String(UPLOAD_WINDOW_SECONDS));
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  // SAFETY: POST /uploads answers JSON.
  const body = (await res.json()) as {
    id?: string;
    url?: string;
    error?: string;
    retryAfter?: number;
  };
  expect(body.url).toBeUndefined();
  expect(body.id).toBeUndefined();
  expect(body.retryAfter).toBe(UPLOAD_WINDOW_SECONDS);
  expect(body.error).toEqual(expect.any(String));
}

describe("02-upload-handshake", () => {
  it("Upload requests are rate-limited per user", async () => {
    await windowHeadroom(UPLOAD_WINDOW_SECONDS);
    const first = await signIn("limit-user");
    await spend(first.cookie, UPLOAD_USER_LIMIT);

    // Even from another address, and with everything a request needs.
    await expectTooManyRequests(await requestUpload(first.cookie));
    expect(await uploadsOf(first.userId)).toEqual([]);

    // Another user is not held up with them.
    const second = await signIn("limit-other");
    expect((await requestUpload(second.cookie)).status).toBe(200);
    expect(await uploadsOf(second.userId)).toHaveLength(1);
  });

  it("Upload requests are rate-limited per IP", async () => {
    await windowHeadroom(UPLOAD_WINDOW_SECONDS);
    const ip = freshIp();
    // Two users from one address spend its limit between them, neither at their own.
    const users = [
      await signIn("limit-ip-a"),
      await signIn("limit-ip-b"),
      await signIn("limit-ip-c"),
    ];
    await spend(users[0]!.cookie, UPLOAD_IP_LIMIT / 2, ip);
    await spend(users[1]!.cookie, UPLOAD_IP_LIMIT / 2, ip);

    await expectTooManyRequests(await requestUpload(users[2]!.cookie, UPLOAD_TOKEN, ip));
    expect(await uploadsOf(users[2]!.userId)).toEqual([]);

    // Another address is not held up with it.
    expect((await requestUpload(users[2]!.cookie)).status).toBe(200);
  });
});

describe("19-surge-controls", () => {
  it("A user over their limit doesn't spend the budget of an address others share", async () => {
    await windowHeadroom(UPLOAD_WINDOW_SECONDS);
    const ip = freshIp();
    const [noisy, quiet] = [await signIn("shared-noisy"), await signIn("shared-quiet")];
    await spend(noisy.cookie, UPLOAD_USER_LIMIT, ip);
    // More refused requests than the IP has budget left for.
    for (let i = 0; i < UPLOAD_IP_LIMIT; i++) {
      expect((await requestUpload(noisy.cookie, UPLOAD_TOKEN, ip)).status).toBe(429);
    }
    expect((await requestUpload(quiet.cookie, UPLOAD_TOKEN, ip)).status).toBe(200);
  });

  it("Upload requests are throttled per user", async () => {
    await windowHeadroom(UPLOAD_WINDOW_SECONDS);
    const { userId, cookie } = await signIn("throttle-user");
    await spend(cookie, UPLOAD_USER_LIMIT);

    await expectTooManyRequests(await requestUpload(cookie));
    expect(await uploadsOf(userId)).toEqual([]);
  });

  it("A signed-out request is still refused with a 401, not counted", async () => {
    await windowHeadroom(UPLOAD_WINDOW_SECONDS);
    const ip = freshIp();
    for (let i = 0; i < UPLOAD_IP_LIMIT + 1; i++) {
      const res = await postLogin(
        { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
        { url: "/uploads", headers: { "cf-connecting-ip": ip } },
      );
      expect(res.status).toBe(401);
    }
    // None of them was counted: a signed-in user at the same address still gets through.
    const { cookie } = await signIn("signed-out-ip");
    expect((await requestUpload(cookie, UPLOAD_TOKEN, ip)).status).toBe(200);
  });

  it("A failing rate limiter lets a request through and logs no user, IP or key", async () => {
    const { userId, cookie } = await signIn("limiter-down");
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
        new Request(`${BASE}/uploads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: BASE,
            "sec-fetch-site": "same-origin",
            "cf-connecting-ip": ip,
            cookie,
          },
          body: new URLSearchParams({
            size: "1000",
            "cf-turnstile-response": UPLOAD_TOKEN,
          }).toString(),
        }),
        { ...env, UPLOAD_IP_LIMIT: failing, UPLOAD_USER_LIMIT: failing },
        ctx,
      );
      status = res.status;
      await waitOnExecutionContext(ctx);
    });

    expect(status).toBe(200);
    expect(keys).toHaveLength(2);
    expect(logged.length).toBeGreaterThan(0);
    const log = logged.join("\n");
    for (const secret of [userId, ip, "limiter-down", ...keys]) expect(log).not.toContain(secret);
  });
});
