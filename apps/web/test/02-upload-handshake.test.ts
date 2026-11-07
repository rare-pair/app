import { createDb, type UploadStatus } from "@archive/db";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import {
  fetchW,
  freshIp,
  TURNSTILE,
  nonceOf,
  UPLOAD_TOKEN,
  postLogin,
  postLoginWithVars,
  TIERS,
  signIn as signInAs,
  withoutHeader,
  withoutNonce,
} from "./helpers";

// U1's cases: the upload page and `POST /uploads`, which makes an upload's row and answers with
// its id. The file then goes to `PUT /uploads/:id` (02-upload-put.test.ts).

// One database serves every test file of a project, so each test signs in its own user
// and finds rows by that user.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/**
 * Signs `email` in through the Worker, with the terms accepted, and returns the user's id
 * and the `name=value` of the session cookie.
 */
async function signIn(email: string): Promise<{ userId: string; cookie: string }> {
  const cookie = await signInAs(email, { next: "/upload", acceptTerms: true });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { userId: user.id, cookie };
}

/** The upload page's script asking to upload, as a browser on rarepair.fans sends it. */
const requestUpload = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  postLogin(fields, { url: "/uploads", headers });

const uploadsOf = (userId: string) =>
  db
    .selectFrom("uploads")
    .select(["id", "r2_key", "bytes", "status", "sha256"])
    .where("user_id", "=", userId)
    .execute();

type Reply = { id?: string; error?: string };

/** The JSON reply of a refused request: an error to show, and nothing else. */
async function expectRefused(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // SAFETY: POST /uploads answers JSON.
  const body = (await res.json()) as Reply;
  expect(body.id).toBeUndefined();
  expect(body.error).toEqual(expect.any(String));
  return body.error!;
}

describe("01-auth-magic-link", () => {
  it("Uploading needs an account", async () => {
    const page = await fetchW("/upload");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2Fupload");
    expect(page.headers.get("cache-control")).toBe("no-store");

    const res = await requestUpload({ size: "1000", "cf-turnstile-response": UPLOAD_TOKEN });
    await expectRefused(res, 401);
  });
});

describe("02-upload-handshake", () => {
  it("Upload request makes an upload and returns its id", async () => {
    const { userId, cookie } = await signIn("u1-returns-id@example.test");
    const res = await requestUpload(
      { size: "123456", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // SAFETY: POST /uploads answers JSON.
    const reply = (await res.json()) as Reply;
    // No link to the bucket: an id, and nothing else.
    expect(Object.keys(reply)).toEqual(["id"]);
    const { id } = reply;

    expect(await uploadsOf(userId)).toEqual([
      { id, r2_key: `uploads/${id}`, bytes: 123456, status: "pending", sha256: null },
    ]);
  });

  it("Declared size of exactly 25 MB is accepted", async () => {
    const { userId, cookie } = await signIn("u1-exactly-25@example.test");
    const res = await requestUpload(
      { size: "26214400", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect((await uploadsOf(userId)).map((row) => row.bytes)).toEqual([26214400]);
  });

  it("Declared size over 25 MB is refused", async () => {
    const { userId, cookie } = await signIn("u1-over-25@example.test");
    const res = await requestUpload(
      { size: "26214401", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    expect(await expectRefused(res, 413)).toMatch(/over the 25 MB limit/);
    expect(await uploadsOf(userId)).toEqual([]);
  });

  it("Upload request without a session is refused", async () => {
    const res = await requestUpload({ size: "1000", "cf-turnstile-response": UPLOAD_TOKEN });
    await expectRefused(res, 401);
    // A cookie that names no session is no session.
    const forged = await requestUpload(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie: "__Secure-better-auth.session_token=forged.value" },
    );
    await expectRefused(forged, 401);
  });

  it("Upload request without Turnstile is refused", async () => {
    const { userId, cookie } = await signIn("u1-no-turnstile@example.test");
    const missingOrFailing: Record<string, string>[] = [
      { size: "1000" },
      { size: "1000", "cf-turnstile-response": "bad" },
    ];
    for (const fields of missingOrFailing) {
      const res = await requestUpload(fields, { cookie });
      expect(await expectRefused(res, 400)).toMatch(/anti-spam check/);
    }
    // Turnstile not answering is not the uploader's fault.
    const down = await requestUpload(
      { size: "1000", "cf-turnstile-response": "siteverify-down" },
      { cookie },
    );
    await expectRefused(down, 503);
    expect(await uploadsOf(userId)).toEqual([]);
  });

  it("A declared size that is not a positive whole number is refused", async () => {
    const { userId, cookie } = await signIn("u1-bad-size@example.test");
    const token = { "cf-turnstile-response": UPLOAD_TOKEN };
    await expectRefused(await requestUpload(token, { cookie }), 400);
    for (const size of ["", "abc", "-1", "0", "1.5", "1e3", " 12", "0x10"]) {
      await expectRefused(await requestUpload({ ...token, size }, { cookie }), 400);
    }
    expect(await uploadsOf(userId)).toEqual([]);
  });

  it("An upload request from another site is refused", async () => {
    const { userId, cookie } = await signIn("u1-cross-site@example.test");
    const fields = { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN };
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://www.rarepair.fans", "sec-fetch-site": "same-site" },
    ]) {
      const res = await requestUpload(fields, { cookie, ...headers });
      await expectRefused(res, 403);
    }
    expect(await uploadsOf(userId)).toEqual([]);
  });

  it("Upload page without JavaScript explains it is needed", async () => {
    const { cookie } = await signIn("u1-noscript@example.test");
    const res = await fetchW("/upload", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy");
    // Nothing past the Turnstile pages' policy: files go to this site, under default-src 'self'.
    expect(withoutNonce(csp)).toBe(TURNSTILE);

    const html = await res.text();
    const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";
    expect(noscript).toMatch(/Uploading needs JavaScript/);
    // Nothing on the page can send a file without the script: no form posts anywhere.
    // (Narrowed to exclude the header, whose Sign out form posts to /logout: asserted in
    // 20-site-header.test.ts, which allows that one action only.)
    expect(withoutHeader(html)).not.toMatch(/<form\b[^>]*\baction=/i);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.epub,application\/epub\+zip"/);
    expect(html).toContain(
      `<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-action="upload">`,
    );
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonceOf(csp)}"`);
  });

  it("The upload page's script is served with the page's nonce and nothing else is let in", async () => {
    const { cookie } = await signIn("u3-script-tag@example.test");
    const res = await fetchW("/upload", { headers: { cookie } });
    const html = await res.text();
    const tag = html.match(/<script src="(\/assets\/upload\.[0-9a-f]+\.js)"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).toContain(`nonce="${nonceOf(res.headers.get("content-security-policy"))}"`);
    const script = await fetchW(tag![1]!);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // Only the page's own address: nothing else the script could send a file to.
    expect(res.headers.get("content-security-policy")).not.toContain("connect-src");
  });

  it("The upload page has the site's chrome", async () => {
    // What 20-site-chrome and 11-reader-and-csp check on pages anyone can open.
    const { cookie } = await signIn("u1-chrome@example.test");
    const html = await (await fetchW("/upload", { headers: { cookie } })).text();
    const count = (pattern: RegExp) => (html.match(pattern) ?? []).length;
    expect(count(/<[a-z]+ class="banner"[^>]*>[^<]*unofficial/gi)).toBe(1);
    expect(html.indexOf('class="banner"')).toBeLessThan(html.indexOf("<main"));
    for (const landmark of [/<h1\b/g, /<header\b/g, /<main id="main">/g, /<footer\b/g]) {
      expect(count(landmark)).toBe(1);
    }
    expect(html.match(/<a\b[^>]*>/)?.[0]).toBe('<a class="skip" href="#main">');
    expect(html).toMatch(/<footer>[^]*<a href="\/remove">Remove my work<\/a>[^]*<\/footer>/);
    expect(count(/<link rel="stylesheet"/g)).toBe(1);
    expect(html).not.toMatch(/style=|<style/i);
    expect(
      count(/<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js"/g),
    ).toBe(1);
    expect(html).not.toMatch(/AO3|OTW|Archive of Our Own|woff2|@font-face/i);
  });
});

describe("19-surge-controls-and-quotas", () => {
  it("Turnstile guards upload requests", async () => {
    const { userId, cookie } = await signIn("u1-surge-turnstile@example.test");
    const res = await requestUpload({ size: "1000", "cf-turnstile-response": "bad" }, { cookie });
    expect(await expectRefused(res, 400)).toMatch(/anti-spam check did not pass/);
    expect(await uploadsOf(userId)).toEqual([]);
  });
});

// U4: today's confirmed uploads are counted at `/complete` (02-upload-confirm.test.ts), so
// `POST /uploads` only refuses early, when the quota is already spent.
const NEW_LIMIT = Number(env.UPLOAD_QUOTA_NEW);
const LOWER_NEW_LIMIT = Number(TIERS.UPLOAD_QUOTA_NEW);
const TRUSTED_LIMIT = Number(TIERS.UPLOAD_QUOTA_TRUSTED);
// The database's UTC day, the clock the quota itself uses, not the JS clock.
const today = sql<string>`(now() at time zone 'utc')::date`;
const setUsedToday = (userId: string, used: number) =>
  db
    .updateTable("user")
    .set({ upload_quota_used: used, upload_quota_day: today })
    .where("id", "=", userId)
    .execute();

describe("02-upload-handshake: the daily quota", () => {
  it("Upload request over the daily quota is refused", async () => {
    const { userId, cookie } = await signIn("u4-over-quota@example.test");
    await setUsedToday(userId, NEW_LIMIT);
    const res = await requestUpload(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    const error = await expectRefused(res.clone(), 429);
    expect(error).toMatch(/midnight UTC/);
    const seconds = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(86400);
    // SAFETY: POST /uploads answers JSON.
    expect(((await res.json()) as { retryAfter?: number }).retryAfter).toBe(seconds);
    expect(await uploadsOf(userId)).toEqual([]);
  });
});

describe("02-upload-handshake: the cap on open uploads", () => {
  /** `n` uploads by `userId` in `status`, as `POST /uploads` leaves one that was never confirmed. */
  async function opened(
    userId: string,
    n: number,
    fields: { status?: UploadStatus; quota_counted_at?: Date } = {},
  ) {
    const rows = Array.from({ length: n }, () => {
      const id = crypto.randomUUID();
      return { id, user_id: userId, r2_key: `uploads/${id}`, bytes: 1000, ...fields };
    });
    await db.insertInto("uploads").values(rows).execute();
  }

  const ask = (cookie: string, files: number, vars: Record<string, string> = {}) =>
    postLoginWithVars(
      vars,
      {},
      {
        url: "/uploads",
        // Its own address: the rate limit isn't what these cases are about.
        headers: { cookie, "cf-connecting-ip": freshIp() },
        body: new URLSearchParams([
          ...Array.from({ length: files }, (): [string, string] => ["size", "1000"]),
          ["cf-turnstile-response", UPLOAD_TOKEN],
        ]).toString(),
      },
    );

  it("Asking for uploads beyond the cap on open uploads is refused", async () => {
    const { userId, cookie } = await signIn("uploadcap-at-cap@example.test");
    await opened(userId, NEW_LIMIT);

    const res = await ask(cookie, 1);

    const error = await expectRefused(res.clone(), 429);
    expect(error).toMatch(/unfinished uploads/);
    expect(error).toMatch(/try again/);
    expect(res.headers.get("retry-after")).toBe("3600");
    // SAFETY: POST /uploads answers JSON.
    expect(((await res.json()) as { retryAfter?: number }).retryAfter).toBe(3600);
    expect(await uploadsOf(userId)).toHaveLength(NEW_LIMIT);
  });

  it("A batch that fits under the cap works, and one past it is refused whole", async () => {
    const { userId, cookie } = await signIn("uploadcap-fits@example.test");
    await opened(userId, NEW_LIMIT - 2);

    expect(await expectRefused(await ask(cookie, 3), 429)).toMatch(/2 more/);
    expect(await uploadsOf(userId)).toHaveLength(NEW_LIMIT - 2);

    expect((await ask(cookie, 2)).status).toBe(200);
    expect(await uploadsOf(userId)).toHaveLength(NEW_LIMIT);
  });

  it("A full batch of 10 files still works under the cap", async () => {
    const { userId, cookie } = await signIn("uploadcap-ten@example.test");
    await opened(userId, NEW_LIMIT - 10);
    expect((await ask(cookie, 10)).status).toBe(200);
    expect(await uploadsOf(userId)).toHaveLength(NEW_LIMIT);
  });

  it("The cap is the account's daily quota for its tier", async () => {
    const { userId, cookie } = await signIn("uploadcap-trusted@example.test");
    await db.updateTable("user").set({ role: "moderator" }).where("id", "=", userId).execute();
    await opened(userId, LOWER_NEW_LIMIT);
    expect((await ask(cookie, 1, TIERS)).status).toBe(200);

    await opened(userId, TRUSTED_LIMIT - LOWER_NEW_LIMIT - 1);
    await expectRefused(await ask(cookie, 1, TIERS), 429);
  });

  it("Only the account's own unconfirmed uploads are open", async () => {
    const { userId, cookie } = await signIn("uploadcap-not-open@example.test");
    const other = await signIn("uploadcap-not-open-other@example.test");
    await opened(other.userId, NEW_LIMIT);
    await opened(userId, 5, { status: "pending", quota_counted_at: new Date() });
    await opened(userId, 5, { status: "processing" });
    await opened(userId, 5, { status: "too_large" });
    await opened(userId, NEW_LIMIT - 1);
    expect((await ask(cookie, 1)).status).toBe(200);
  });
});

describe("19-surge-controls-and-quotas: asking while quota is left", () => {
  it("Daily quota allows uploads up to the limit", async () => {
    const { userId, cookie } = await signIn("u4-ask-last@example.test");
    await setUsedToday(userId, NEW_LIMIT - 1);
    const res = await requestUpload(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(await uploadsOf(userId)).toHaveLength(1);
  });

  it("Daily quota refuses uploads past the limit", async () => {
    const { userId, cookie } = await signIn("u4-ask-past@example.test");
    await setUsedToday(userId, NEW_LIMIT + 5);
    const res = await requestUpload(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    await expectRefused(res, 429);
    expect(res.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
  });

  it("a trusted user is asked past the new-account limit", async () => {
    const { userId, cookie } = await signIn("u4-ask-trusted@example.test");
    await db.updateTable("user").set({ role: "admin" }).where("id", "=", userId).execute();
    const request = () =>
      postLoginWithVars(
        TIERS,
        { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
        { url: "/uploads", headers: { cookie } },
      );
    await setUsedToday(userId, LOWER_NEW_LIMIT);
    expect((await request()).status).toBe(200);
    await setUsedToday(userId, TRUSTED_LIMIT);
    await expectRefused(await request(), 429);
  });

  it("an earlier day's use is no use today", async () => {
    const { userId, cookie } = await signIn("u4-ask-new-day@example.test");
    await db
      .updateTable("user")
      .set({ upload_quota_used: NEW_LIMIT, upload_quota_day: "2000-01-01" })
      .where("id", "=", userId)
      .execute();
    const res = await requestUpload(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    expect(res.status).toBe(200);
  });

  it("a request that fails an earlier check is answered by that check, not the quota", async () => {
    const { userId, cookie } = await signIn("u4-ask-order@example.test");
    await setUsedToday(userId, NEW_LIMIT);
    const big = await requestUpload(
      { size: "26214401", "cf-turnstile-response": UPLOAD_TOKEN },
      { cookie },
    );
    await expectRefused(big, 413);
    const bad = await requestUpload({ size: "1000", "cf-turnstile-response": "bad" }, { cookie });
    await expectRefused(bad, 400);
  });
});
