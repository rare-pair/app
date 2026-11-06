import { banUser, createDb, insertUpload } from "@archive/db";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { BASE, fetchW, freshIp, postLogin, signIn as signInAs, UPLOAD_TOKEN } from "./helpers";

// `PUT /uploads/:id`, where the page's script sends a file and the Worker streams it to R2, and
// `DELETE /uploads/:id`, where the page gives up on one. A test that needs a body a browser
// wouldn't send, such as one longer than its Content-Length or one that dies midway, calls the
// app in this isolate: `exports.default.fetch` would re-frame the request over its binding.
// What real R2 does with a dropped stream is the post-deploy check in spec 02.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const EPUB = "application/epub+zip";
const MAX = 25 * 1024 * 1024;
const NEW_LIMIT = Number(env.UPLOAD_QUOTA_NEW);
const SAME_ORIGIN = { origin: BASE, "sec-fetch-site": "same-origin" };

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

/** An upload as `POST /uploads` leaves it: a row, no object. */
async function opened(userId: string, bytes: number) {
  const id = crypto.randomUUID();
  const key = `uploads/${id}`;
  await insertUpload(db, { id, userId, r2Key: key, bytes });
  return { id, key };
}

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** The page's script sending a file, as a browser on rarepair.fans does. */
const put = (id: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetchW(`/uploads/${id}`, {
    method: "PUT",
    headers: { "content-type": EPUB, ...SAME_ORIGIN, ...headers },
    body,
  });

const giveUp = (id: string, headers: Record<string, string> = {}) =>
  fetchW(`/uploads/${id}`, { method: "DELETE", headers: { ...SAME_ORIGIN, ...headers } });

/** A PUT with this exact body and these exact headers, in this isolate. */
async function putRaw(
  id: string,
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string>,
  bindings: { BUCKET?: Pick<R2Bucket, "head" | "delete"> & { put: () => Promise<never> } } = {},
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    // SAFETY: `duplex` is what workerd needs of a stream body, and RequestInit has no such field.
    new Request(`${BASE}/uploads/${id}`, {
      method: "PUT",
      headers: { "content-type": EPUB, ...SAME_ORIGIN, ...headers },
      body,
      duplex: "half",
    } as RequestInit),
    { ...env, ...bindings },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** A body of these chunk sizes. */
const bodyOf = (...sizes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of sizes) controller.enqueue(randomBytes(size));
      controller.close();
    },
  });

/** A body the test feeds by hand; `reading` resolves once the Worker has started to read it. */
function heldBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => (started = resolve));
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        started();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, reading, controller: () => controller };
}

const rowOf = (id: string) =>
  db
    .selectFrom("uploads")
    .select(["status", "quota_counted_at"])
    .where("id", "=", id)
    .executeTakeFirst();

async function expectRefused(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // SAFETY: the upload routes answer JSON.
  const body = (await res.json()) as { error?: string };
  expect(body.error).toEqual(expect.any(String));
}

/** The upload's row and object are gone. */
async function expectFreed(up: { id: string; key: string }) {
  expect(await rowOf(up.id)).toBeUndefined();
  expect(await env.BUCKET.head(up.key)).toBeNull();
}

/** One more upload can be asked for: for an account that was at the cap, its slot is back. */
async function expectCapUsable(cookie: string) {
  const res = await postLogin(
    { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
    { url: "/uploads", headers: { cookie, "cf-connecting-ip": freshIp() } },
  );
  expect(res.status).toBe(200);
}

/** All but one of the account's `NEW_LIMIT` open uploads, so the next one fills the cap. */
async function fillCap(userId: string) {
  const rows = Array.from({ length: NEW_LIMIT - 1 }, () => {
    const id = crypto.randomUUID();
    return { id, user_id: userId, r2_key: `uploads/${id}`, bytes: 1000 };
  });
  await db.insertInto("uploads").values(rows).execute();
}

describe("02-upload-handshake", () => {
  it("The Worker streams a sent file to R2", async () => {
    const { userId, cookie } = await signIn("upslot-put");
    const bytes = randomBytes(1000);
    const up = await opened(userId, 1000);

    const res = await put(up.id, bytes, { cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const object = await env.BUCKET.get(up.key);
    expect(object?.size).toBe(1000);
    expect(object?.httpMetadata?.contentType).toBe(EPUB);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
    // Sent, not confirmed: the row is still open and nothing is counted.
    expect(await rowOf(up.id)).toEqual({ status: "pending", quota_counted_at: null });
  });

  it("A file of exactly 25 MiB is stored", async () => {
    const { userId, cookie } = await signIn("upslot-exact");
    const up = await opened(userId, MAX);
    expect((await put(up.id, new Uint8Array(MAX), { cookie })).status).toBe(200);
    expect((await env.BUCKET.head(up.key))?.size).toBe(MAX);
  });

  it("A sent file without a session is refused", async () => {
    const { userId } = await signIn("upslot-no-session");
    const up = await opened(userId, 10);
    await expectRefused(await put(up.id, randomBytes(10)), 401);
    expect(await env.BUCKET.head(up.key)).toBeNull();
    expect(await rowOf(up.id)).toBeDefined();
  });

  it("A sent file from another site is refused", async () => {
    const { userId, cookie } = await signIn("upslot-cross-site");
    const up = await opened(userId, 10);
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://www.rarepair.fans", "sec-fetch-site": "same-site" },
    ]) {
      await expectRefused(await put(up.id, randomBytes(10), { cookie, ...headers }), 403);
    }
    expect(await env.BUCKET.head(up.key)).toBeNull();
    expect(await rowOf(up.id)).toBeDefined();
  });

  it("A sent file for another user's upload and for an unknown one are refused alike", async () => {
    const owner = await signIn("upslot-owner");
    const other = await signIn("upslot-other");
    const up = await opened(owner.userId, 10);
    const theirs = await put(up.id, randomBytes(10), { cookie: other.cookie });
    const unknown = await put(crypto.randomUUID(), randomBytes(10), { cookie: other.cookie });
    await expectRefused(theirs.clone(), 404);
    await expectRefused(unknown.clone(), 404);
    expect(await theirs.json()).toEqual(await unknown.json());
    expect(await env.BUCKET.head(up.key)).toBeNull();
    expect(await rowOf(up.id)).toBeDefined();
  });

  it("An id no upload can have is an unknown upload, not a fault", async () => {
    const { cookie } = await signIn("upslot-bad-id");
    await expectRefused(await put("%00", randomBytes(10), { cookie }), 404);
    await expectRefused(await put("x".repeat(65), randomBytes(10), { cookie }), 404);
  });

  it("A sent file from a banned account is refused and stores nothing", async () => {
    const { userId, cookie } = await signIn("upslot-banned");
    // A row written after the ban, by a request that had passed its check just before.
    const up = await opened(userId, 10);
    await db.updateTable("user").set({ banned_at: new Date() }).where("id", "=", userId).execute();

    await expectRefused(await put(up.id, randomBytes(10), { cookie }), 403);

    expect(await env.BUCKET.head(up.key)).toBeNull();
    expect((await rowOf(up.id))?.status).toBe("account_banned");
  });

  it("A sent file for an upload a ban has ended stores nothing", async () => {
    const { userId, cookie } = await signIn("upslot-ban-ended");
    const moderator = await signIn("upslot-ban-moderator");
    const up = await opened(userId, 10);
    expect(await banUser(db, userId, { actor: moderator.userId })).toBe("banned");

    const res = await put(up.id, randomBytes(10), { cookie });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await env.BUCKET.head(up.key)).toBeNull();
    expect((await rowOf(up.id))?.status).toBe("account_banned");
  });

  it("A sent file with another content type is refused and frees its slot", async () => {
    const { userId, cookie } = await signIn("upslot-type");
    await fillCap(userId);
    const up = await opened(userId, 10);
    await expectRefused(
      await put(up.id, randomBytes(10), { cookie, "content-type": "application/zip" }),
      415,
    );
    await expectFreed(up);
    await expectCapUsable(cookie);
  });

  it("A sent file with no Content-Length is refused and frees its slot", async () => {
    const { userId, cookie } = await signIn("upslot-no-length");
    const up = await opened(userId, 10);
    await expectRefused(await putRaw(up.id, bodyOf(10), { cookie }), 411);
    await expectFreed(up);
  });

  it("A sent file whose Content-Length differs from the size declared is refused and frees its slot", async () => {
    const { userId, cookie } = await signIn("upslot-length");
    for (const sent of [9, 11]) {
      const up = await opened(userId, 10);
      await expectRefused(await put(up.id, randomBytes(sent), { cookie }), 400);
      await expectFreed(up);
    }
  });

  it("A sent file declaring over 25 MB is refused before a byte is read, and frees its slot", async () => {
    const { userId, cookie } = await signIn("upslot-over");
    await fillCap(userId);
    const up = await opened(userId, 10);
    const body = heldBody();
    await expectRefused(
      await putRaw(up.id, body.stream, { cookie, "content-length": String(MAX + 1) }),
      413,
    );
    await expectFreed(up);
    await expectCapUsable(cookie);
  });

  it.each([
    ["longer", [6, 6]],
    ["shorter", [6]],
  ])(
    "A body longer or shorter than its Content-Length stores nothing and frees its slot: %s",
    async (word, chunks) => {
      const { userId, cookie } = await signIn(`upslot-lying-${word}`);
      await fillCap(userId);
      const up = await opened(userId, 10);
      await expectRefused(
        await putRaw(up.id, bodyOf(...chunks), { cookie, "content-length": "10" }),
        400,
      );
      await expectFreed(up);
      await expectCapUsable(cookie);
    },
  );

  it("A dropped upload stores nothing and frees its slot", async () => {
    const { userId, cookie } = await signIn("upslot-dropped");
    await fillCap(userId);
    const up = await opened(userId, 10);
    const body = heldBody();
    const sent = putRaw(up.id, body.stream, { cookie, "content-length": "10" });
    await body.reading;
    body.controller().enqueue(randomBytes(4));
    body.controller().error(new Error("the connection went away"));
    await expectRefused(await sent, 400);
    await expectFreed(up);
    await expectCapUsable(cookie);
  });

  it("A store that R2 refuses frees the slot", async () => {
    const { userId, cookie } = await signIn("upslot-r2-down");
    const up = await opened(userId, 10);
    const bucket = {
      put: async () => {
        throw new TypeError("R2 is down");
      },
      delete: (key: string) => env.BUCKET.delete(key),
      head: (key: string) => env.BUCKET.head(key),
    };
    await expectRefused(
      await putRaw(up.id, bodyOf(10), { cookie, "content-length": "10" }, { BUCKET: bucket }),
      400,
    );
    await expectFreed(up);
  });

  it("A second file sent to an open upload stores nothing, and the first stays", async () => {
    const { userId, cookie } = await signIn("upslot-second");
    const first = randomBytes(10);
    const up = await opened(userId, 10);
    expect((await put(up.id, first, { cookie })).status).toBe(200);

    await expectRefused(await put(up.id, randomBytes(10), { cookie }), 409);

    const object = await env.BUCKET.get(up.key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(first);
    expect(await rowOf(up.id)).toEqual({ status: "pending", quota_counted_at: null });
  });

  it("A send repeated after its answer was lost can still be confirmed, once", async () => {
    const { userId, cookie } = await signIn("upslot-repeat-confirm");
    const bytes = randomBytes(10);
    const up = await opened(userId, 10);
    expect((await put(up.id, bytes, { cookie })).status).toBe(200);
    expect((await put(up.id, bytes, { cookie })).status).toBe(409);

    const confirmed = await postLogin(
      {},
      { url: `/uploads/${up.id}/complete`, headers: { cookie } },
    );

    expect(confirmed.status).toBe(200);
    expect((await rowOf(up.id))?.quota_counted_at).not.toBeNull();
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("A second file is refused before its body is read, whatever its headers", async () => {
    const { userId, cookie } = await signIn("upslot-second-unread");
    const first = randomBytes(10);
    const up = await opened(userId, 10);
    expect((await put(up.id, first, { cookie })).status).toBe(200);

    // Never fed, so a route that read it would hang here.
    const unread = heldBody();
    await expectRefused(
      await putRaw(up.id, unread.stream, { cookie, "content-length": "10" }),
      409,
    );
    await expectRefused(
      await put(up.id, randomBytes(10), { cookie, "content-type": "application/zip" }),
      409,
    );

    const object = await env.BUCKET.get(up.key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(first);
  });

  it.each(["abc", "-1", "1e1", ""])(
    "A Content-Length that isn't a whole number is refused and frees its slot: %j",
    async (length) => {
      const { userId, cookie } = await signIn("upslot-bad-length");
      const up = await opened(userId, 10);
      await expectRefused(
        await putRaw(up.id, bodyOf(10), { cookie, "content-length": length }),
        411,
      );
      await expectFreed(up);
    },
  );

  it.each(["duplicate", "too_large", "over_quota", "processing", "live"] as const)(
    "A file sent to an upload that has ended stores nothing: %s",
    async (status) => {
      const { userId, cookie } = await signIn(`upslot-ended-${status}`);
      const up = await opened(userId, 10);
      await db.updateTable("uploads").set({ status }).where("id", "=", up.id).execute();
      await expectRefused(await put(up.id, randomBytes(10), { cookie }), 409);
      expect(await env.BUCKET.head(up.key)).toBeNull();
      expect((await rowOf(up.id))?.status).toBe(status);
    },
  );

  it("A file sent to an upload that has ended stores nothing: counted by a confirm", async () => {
    const { userId, cookie } = await signIn("upslot-counted");
    const up = await opened(userId, 10);
    await db
      .updateTable("uploads")
      .set({ quota_counted_at: new Date() })
      .where("id", "=", up.id)
      .execute();
    await expectRefused(await put(up.id, randomBytes(10), { cookie }), 409);
    expect(await env.BUCKET.head(up.key)).toBeNull();
  });

  /** Sends all but the last bytes, does `meanwhile`, sends the rest, and returns the reply. */
  async function endingMidway(
    cookie: string,
    id: string,
    meanwhile: () => Promise<object | string>,
  ): Promise<Response> {
    const body = heldBody();
    const sent = putRaw(id, body.stream, { cookie, "content-length": "10" });
    await body.reading;
    body.controller().enqueue(randomBytes(4));
    await meanwhile();
    body.controller().enqueue(randomBytes(6));
    body.controller().close();
    return sent;
  }

  it("An upload removed while its file arrives keeps no object", async () => {
    const { userId, cookie } = await signIn("upslot-reaped-midway");
    const up = await opened(userId, 10);
    const res = await endingMidway(cookie, up.id, () =>
      db.deleteFrom("uploads").where("id", "=", up.id).execute(),
    );
    await expectRefused(res, 409);
    expect(await env.BUCKET.head(up.key)).toBeNull();
  });

  it("An upload a ban ends while its file arrives keeps no object", async () => {
    const { userId, cookie } = await signIn("upslot-banned-midway");
    const moderator = await signIn("upslot-banned-midway-moderator");
    const up = await opened(userId, 10);
    const res = await endingMidway(cookie, up.id, () =>
      banUser(db, userId, { actor: moderator.userId }),
    );
    await expectRefused(res, 409);
    expect(await env.BUCKET.head(up.key)).toBeNull();
    expect((await rowOf(up.id))?.status).toBe("account_banned");
  });

  it("An upload a confirm counts as its file finishes keeps its object for ingest", async () => {
    const { userId, cookie } = await signIn("upslot-counted-midway");
    const up = await opened(userId, 10);
    const res = await endingMidway(cookie, up.id, () =>
      db
        .updateTable("uploads")
        .set({ quota_counted_at: new Date() })
        .where("id", "=", up.id)
        .execute(),
    );
    expect(res.status).toBe(200);
    expect((await env.BUCKET.head(up.key))?.size).toBe(10);
  });

  it("A slow file that arrives after ingest has finished its upload keeps no object", async () => {
    const { userId, cookie } = await signIn("upslot-after-ingest");
    const up = await opened(userId, 10);
    const res = await endingMidway(cookie, up.id, () =>
      db
        .updateTable("uploads")
        .set({ status: "live", quota_counted_at: new Date() })
        .where("id", "=", up.id)
        .execute(),
    );
    await expectRefused(res, 409);
    expect(await env.BUCKET.head(up.key)).toBeNull();
  });
});

describe("19-surge-controls-and-quotas", () => {
  it("Oversized files are refused as they arrive", async () => {
    const { userId, cookie } = await signIn("upslot-oversized");
    const declared = await opened(userId, 10);
    await expectRefused(
      await putRaw(declared.id, bodyOf(10), { cookie, "content-length": String(MAX + 1) }),
      413,
    );
    await expectFreed(declared);
    const arriving = await opened(userId, 10);
    await expectRefused(
      await putRaw(arriving.id, bodyOf(6, 6), { cookie, "content-length": "10" }),
      400,
    );
    await expectFreed(arriving);
  });
});

describe("02-upload-handshake: the page gives up on an upload", () => {
  it("A failed upload the page reports frees its slot", async () => {
    const { userId, cookie } = await signIn("upslot-give-up");
    await fillCap(userId);
    const up = await opened(userId, 10);
    const res = await giveUp(up.id, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectFreed(up);
    await expectCapUsable(cookie);
  });

  it("Reporting an upload whose file arrived removes the file too", async () => {
    const { userId, cookie } = await signIn("upslot-give-up-object");
    const up = await opened(userId, 10);
    expect((await put(up.id, randomBytes(10), { cookie })).status).toBe(200);
    expect((await giveUp(up.id, { cookie })).status).toBe(200);
    await expectFreed(up);
  });

  it("Reporting an upload twice is no fault", async () => {
    const { userId, cookie } = await signIn("upslot-give-up-twice");
    const up = await opened(userId, 10);
    expect((await giveUp(up.id, { cookie })).status).toBe(200);
    await expectRefused(await giveUp(up.id, { cookie }), 404);
  });

  it("Reporting another user's upload frees nothing", async () => {
    const owner = await signIn("upslot-give-up-owner");
    const other = await signIn("upslot-give-up-other");
    const up = await opened(owner.userId, 10);
    expect((await put(up.id, randomBytes(10), { cookie: owner.cookie })).status).toBe(200);
    await expectRefused(await giveUp(up.id, { cookie: other.cookie }), 404);
    expect(await rowOf(up.id)).toBeDefined();
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("Reporting an upload a confirm has counted frees nothing", async () => {
    const { userId, cookie } = await signIn("upslot-give-up-counted");
    const up = await opened(userId, 10);
    expect((await put(up.id, randomBytes(10), { cookie })).status).toBe(200);
    await db
      .updateTable("uploads")
      .set({ quota_counted_at: new Date() })
      .where("id", "=", up.id)
      .execute();
    await expectRefused(await giveUp(up.id, { cookie }), 404);
    expect(await rowOf(up.id)).toBeDefined();
    expect(await env.BUCKET.head(up.key)).not.toBeNull();
  });

  it("Reporting an upload that has ended frees nothing", async () => {
    const { userId, cookie } = await signIn("upslot-give-up-ended");
    const up = await opened(userId, 10);
    await db.updateTable("uploads").set({ status: "processing" }).where("id", "=", up.id).execute();
    await expectRefused(await giveUp(up.id, { cookie }), 404);
    expect((await rowOf(up.id))?.status).toBe("processing");
  });

  it("Reporting needs an account", async () => {
    const { userId } = await signIn("upslot-give-up-no-session");
    const up = await opened(userId, 10);
    await expectRefused(await giveUp(up.id), 401);
    expect(await rowOf(up.id)).toBeDefined();
  });

  it("Reporting from another site is refused", async () => {
    const { userId, cookie } = await signIn("upslot-give-up-cross-site");
    const up = await opened(userId, 10);
    await expectRefused(
      await giveUp(up.id, {
        cookie,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      }),
      403,
    );
    expect(await rowOf(up.id)).toBeDefined();
  });

  it("An account that hasn't accepted the terms gets a 401 it can act on", async () => {
    const email = `upslot-terms-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const cookie = await signInAs(email, { next: "/upload" });
    const res = await put(crypto.randomUUID(), randomBytes(10), { cookie });
    await expectRefused(res, 401);
    await expectRefused(await giveUp(crypto.randomUUID(), { cookie }), 401);
  });
});
