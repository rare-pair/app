import { createDb, insertUpload, type UploadStatus } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { fetchW, signIn as signInAs } from "./helpers";

// U6a's cases: `GET /uploads/:id`, one upload's status for the user who made it. One
// database serves every test file of a project, so each test signs in its own user and
// this file keeps to work IDs 16000 to 16099.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

let counter = 0;
/** Signs a new user in and returns their id and session cookie. */
async function signIn({ acceptTerms = true } = {}): Promise<{ userId: string; cookie: string }> {
  const email = `u6a-${Date.now()}-${counter++}@example.test`;
  const cookie = await signInAs(email, { next: "/upload", acceptTerms });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { userId: user.id, cookie };
}

/** An upload by `userId` in `status`, optionally pointing at a work. */
async function upload(userId: string, status: UploadStatus, workId: string | null = null) {
  const { id } = await insertUpload(db, {
    userId,
    r2Key: `uploads/${crypto.randomUUID()}`,
    bytes: 1234,
  });
  await db
    .updateTable("uploads")
    .set({
      status,
      work_id: workId,
      sha256: "a".repeat(64),
      error_stage: "stage-marker",
      error: "error-marker",
    })
    .where("id", "=", id)
    .execute();
  return id;
}

const poll = (id: string, cookie?: string) =>
  fetchW(`/uploads/${id}`, { headers: cookie === undefined ? {} : { cookie } });

type Status = { id: string; status: string; work: { id: number; url: string } | null };
// SAFETY: GET /uploads/:id answers JSON.
const statusOf = async (res: Response) => (await res.json()) as Status;

describe("03-upload-status", () => {
  it("Status endpoint reports processing", async () => {
    const { userId, cookie } = await signIn();
    const id = await upload(userId, "processing");

    const res = await poll(id, cookie);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await statusOf(res)).toEqual({ id, status: "processing", work: null });
  });

  it("Status endpoint reports live", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16001, title: "u6a-live" });
    const id = await upload(userId, "live", work.workId);

    expect(await statusOf(await poll(id, cookie))).toEqual({
      id,
      status: "live",
      work: { id: 16001, url: "/works/16001" },
    });
  });

  it("Status endpoint reports held for review", async () => {
    const { userId, cookie } = await signIn();
    const id = await upload(userId, "held_for_review");

    expect(await statusOf(await poll(id, cookie))).toEqual({
      id,
      status: "held_for_review",
      work: null,
    });
  });

  it("Status endpoint reports duplicate", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16002, title: "u6a-duplicate" });
    const id = await upload(userId, "duplicate", work.workId);

    expect(await statusOf(await poll(id, cookie))).toEqual({
      id,
      status: "duplicate",
      work: { id: 16002, url: "/works/16002" },
    });
  });

  it("Live upload with review reasons is still live", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, {
      ao3WorkId: 16003,
      title: "u6a-reasons",
      reviewReasons: ["images_dropped"],
    });
    const id = await upload(userId, "live", work.workId);

    expect((await statusOf(await poll(id, cookie))).status).toBe("live");
  });

  it.each([
    "pending",
    "processing",
    "held_for_review",
    "not_epub",
    "zip_bomb",
    "too_large",
    "not_ao3",
    "opted_out",
    "parse_failed",
  ] satisfies UploadStatus[])("A %s upload's status is its stored status", async (status) => {
    const { userId, cookie } = await signIn();
    const id = await upload(userId, status);

    expect(await statusOf(await poll(id, cookie))).toEqual({ id, status, work: null });
  });

  it("A live upload of a work that is now hidden or removed shows no work", async () => {
    const { userId, cookie } = await signIn();
    const hidden = await seedWork(db, {
      ao3WorkId: 16004,
      title: "u6a-hidden",
      status: "hidden",
      hiddenCause: "moderator",
    });
    const removed = await seedWork(db, {
      ao3WorkId: 16005,
      title: "u6a-removed",
      status: "removed",
    });
    for (const work of [hidden, removed]) {
      const id = await upload(userId, "live", work.workId);
      expect(await statusOf(await poll(id, cookie))).toEqual({ id, status: "live", work: null });
    }
  });

  it("The body carries no internal field", async () => {
    const { userId, cookie } = await signIn();
    const work = await seedWork(db, { ao3WorkId: 16006, title: "u6a-internal" });
    const id = await upload(userId, "live", work.workId);

    const text = await (await poll(id, cookie)).text();

    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["id", "status", "work"]);
    for (const leak of ["uploads/", "aaaaaaaa", "1234", "marker", userId]) {
      expect(text).not.toContain(leak);
    }
  });

  it("Another user's upload and an unknown id answer the same 404", async () => {
    const owner = await signIn();
    const other = await signIn();
    const id = await upload(owner.userId, "processing");

    const theirs = await poll(id, other.cookie);
    const replies = [
      await poll(crypto.randomUUID(), other.cookie),
      await poll("x".repeat(500), other.cookie),
    ];

    expect(theirs.status).toBe(404);
    expect(theirs.headers.get("content-type")).toMatch(/^application\/json/);
    expect(theirs.headers.get("cache-control")).toBe("no-store");
    const body = await theirs.text();
    expect(JSON.parse(body)).toEqual({ error: expect.any(String) });
    expect(body).not.toContain(id);
    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(reply.headers.get("content-type")).toBe(theirs.headers.get("content-type"));
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(await reply.text()).toBe(body);
    }
  });

  it("A signed-out request gets a JSON 401, not a redirect", async () => {
    const { userId } = await signIn();
    const id = await upload(userId, "processing");

    const res = await poll(id);

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("A signed-in user who hasn't accepted the terms gets a JSON 401", async () => {
    const { userId, cookie } = await signIn({ acceptTerms: false });
    const id = await upload(userId, "processing");

    const res = await poll(id, cookie);

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});
