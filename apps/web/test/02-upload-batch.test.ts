import { createDb } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { BASE, freshIp, postLogin, signIn as signInAs, UPLOAD_TOKEN } from "./helpers";

// U3's server half: `POST /uploads` for several files at once, one `size` field each
// under one Turnstile token. The single-file call is U1's (02-upload-handshake.test.ts).

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const S3_HOST = "test0000000000000000000000000acct.r2.cloudflarestorage.com";
const NEW_LIMIT = Number(env.UPLOAD_QUOTA_NEW);

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

const uploadsOf = (userId: string) =>
  db
    .selectFrom("uploads")
    .select(["id", "r2_key", "bytes", "status"])
    .where("user_id", "=", userId)
    .execute();

/** The form the page's script sends: one `size` per file and one token. */
const form = (sizes: string[], token = UPLOAD_TOKEN) =>
  new URLSearchParams([
    ...sizes.map((size): [string, string] => ["size", size]),
    ["cf-turnstile-response", token],
  ]).toString();

const requestBatch = (cookie: string, sizes: string[], token?: string) =>
  postLogin({}, { url: "/uploads", headers: { cookie }, body: form(sizes, token) });

type Reply = { uploads?: { id: string; url: string }[]; id?: string; error?: string };

/** A refused batch: JSON error, no URLs, and not one row. */
async function expectRefused(res: Response, status: number, userId: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // SAFETY: POST /uploads answers JSON.
  const body = (await res.json()) as Reply;
  expect(body.uploads).toBeUndefined();
  expect(body.id).toBeUndefined();
  expect(await uploadsOf(userId)).toEqual([]);
  return body.error!;
}

const today = sql<string>`(now() at time zone 'utc')::date`;
const setUsedToday = (userId: string, used: number) =>
  db
    .updateTable("user")
    .set({ upload_quota_used: used, upload_quota_day: today })
    .where("id", "=", userId)
    .execute();

describe("02-upload-handshake", () => {
  it("Upload of several files in one go", async () => {
    const { userId, cookie } = await signIn("u3-batch");
    const res = await requestBatch(cookie, ["1000", "2000", "26214400"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // SAFETY: POST /uploads answers JSON.
    const { uploads } = (await res.json()) as Reply;
    expect(uploads).toHaveLength(3);
    expect(new Set(uploads!.map((u) => u.id)).size).toBe(3);
    expect(new Set(uploads!.map((u) => u.url)).size).toBe(3);

    const rows = await uploadsOf(userId);
    expect(rows.map((r) => r.bytes).sort((a, b) => a - b)).toEqual([1000, 2000, 26214400]);
    for (const { id, url } of uploads!) {
      const put = new URL(url);
      expect(put.origin).toBe(`https://${S3_HOST}`);
      expect(put.pathname).toBe(`/rarepair/uploads/${id}`);
      expect(put.searchParams.get("X-Amz-Expires")).toBe("600");
      expect(put.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
      expect(rows.find((r) => r.id === id)).toMatchObject({
        r2_key: `uploads/${id}`,
        status: "pending",
      });
    }
  });

  it("A single file keeps the single-file reply", async () => {
    const { cookie } = await signIn("u3-single");
    const res = await requestBatch(cookie, ["1000"]);
    // SAFETY: POST /uploads answers JSON.
    const body = (await res.json()) as Reply;
    expect(Object.keys(body).sort()).toEqual(["id", "url"]);
  });

  it("One file over 25 MB or one bad size refuses the whole batch", async () => {
    const { userId, cookie } = await signIn("u3-bad-sizes");
    const over = await requestBatch(cookie, ["1000", "26214401"]);
    expect(await expectRefused(over, 413, userId)).toMatch(/over the 25 MB limit/);
    await expectRefused(await requestBatch(cookie, ["1000", "abc", "2000"]), 400, userId);
    await expectRefused(await requestBatch(cookie, ["1000", "2000"], "bad"), 400, userId);
  });

  it("A batch of more than ten files is refused", async () => {
    const { userId, cookie } = await signIn("u3-eleven");
    const eleven = await requestBatch(
      cookie,
      Array.from({ length: 11 }, () => "1000"),
    );
    expect(await expectRefused(eleven, 413, userId)).toMatch(/10 files/);
    const ten = await requestBatch(
      cookie,
      Array.from({ length: 10 }, () => "1000"),
    );
    expect(ten.status).toBe(200);
  });
});

describe("19-surge-controls-and-quotas", () => {
  it("A batch larger than the quota left is refused whole, saying how many are left", async () => {
    const { userId, cookie } = await signIn("u3-quota");
    await setUsedToday(userId, NEW_LIMIT - 2);
    const res = await requestBatch(cookie, ["1000", "1000", "1000"]);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await expectRefused(res, 429, userId)).toMatch(/2 uploads left today/);
    // Two fit.
    expect((await requestBatch(cookie, ["1000", "1000"])).status).toBe(200);
  });

  it("A batch spends one of each rate limit per file", async () => {
    const { userId, cookie } = await signIn("u3-limit");
    const calls = { user: 0, ip: 0 };
    const counting = (name: "user" | "ip", allow: number): RateLimit => ({
      limit: async () => ({ success: ++calls[name] <= allow }),
    });
    const send = async (userAllow: number, ipAllow: number, sizes: string[]) => {
      calls.user = 0;
      calls.ip = 0;
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`${BASE}/uploads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: BASE,
            "sec-fetch-site": "same-origin",
            "cf-connecting-ip": freshIp(),
            cookie,
          },
          body: form(sizes),
        }),
        {
          ...env,
          UPLOAD_USER_LIMIT: counting("user", userAllow),
          UPLOAD_IP_LIMIT: counting("ip", ipAllow),
        },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    // Room for three each: a batch of three goes through, and spent three of each.
    expect((await send(3, 3, ["1", "1", "1"])).status).toBe(200);
    expect(calls).toEqual({ user: 3, ip: 3 });
    expect(await uploadsOf(userId)).toHaveLength(3);

    // Room for two: a batch of three is refused, with no more rows.
    const user = await send(2, 3, ["1", "1", "1"]);
    expect(user.status).toBe(429);
    expect(user.headers.get("retry-after")).toBe("60");
    const ip = await send(3, 2, ["1", "1", "1"]);
    expect(ip.status).toBe(429);
    expect(await uploadsOf(userId)).toHaveLength(3);
  });
});
