import { createDb } from "@archive/db";
import { putFragments, seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, failNextPurge, fetchW, purgeRequests, signIn, type PurgeRequest } from "./helpers";

// One database and one bucket serve every test file in the run. This file keeps to AO3
// work IDs 14300 to 14399, plus 143001 (a neighbour whose ID starts with W's digits), and
// gives every marker an "xr1a-" prefix. Text is synthetic.
const W = 14300;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs `email` in with the terms accepted, and gives the account `role`. */
async function signInAs(email: string, role: string | null): Promise<string> {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role }).where("email", "=", email).execute();
  return cookie;
}

const get = (path: string, cookie?: string) =>
  fetchW(path, { headers: cookie === undefined ? {} : { cookie } });

/** A form post as the site's own page makes it, unless `site` says otherwise. */
const post = (
  path: string,
  cookie?: string,
  fields: Record<string, string> = {},
  site: { origin: string; "sec-fetch-site": string } = {
    origin: BASE,
    "sec-fetch-site": "same-origin",
  },
) => {
  const headers = new Headers({ ...site, "content-type": "application/x-www-form-urlencoded" });
  if (cookie !== undefined) headers.set("cookie", cookie);
  return fetchW(path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};

const workRow = (ao3WorkId: number) =>
  db
    .selectFrom("works")
    .select(["id", "status", "hidden_cause"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();

/** A content-hash image key's last segment, as ingest writes it under `img/`. */
const IMAGE_SHA = "ab".repeat(32);

/**
 * A work as ingest leaves it in Postgres and R2: a version replaced by a second and a
 * third held for review, each version's fragments, a shared image, every upload's
 * original, and the first upload's raw file still at its own key. `keys` is every
 * object put, sorted.
 */
async function seedWithObjects(ao3WorkId: number, hidden = false) {
  const seeded = await seedWork(db, {
    ao3WorkId,
    title: `xr1a-title-${ao3WorkId}`,
    chapters: [{ html: "<p>xr1a-one</p>" }, { html: "<p>xr1a-two</p>" }],
    status: hidden ? "hidden" : "live",
    hiddenCause: hidden ? "reports" : undefined,
  });
  const second = await seedVersion(db, seeded, { chapters: 3 });
  const held = await seedVersion(db, seeded, { current: false, chapters: 1 });
  const uploadIds = [seeded.uploadId, second.uploadId, held.uploadId];
  await putFragments(env.BUCKET, [...seeded.fragments, ...second.fragments, ...held.fragments]);
  // The raw file's key as the upload route stores it (no extension), not the seed's.
  const rawKey = `uploads/${seeded.uploadId}`;
  await db
    .updateTable("uploads")
    .set({ r2_key: rawKey })
    .where("id", "=", seeded.uploadId)
    .execute();
  const others = [
    `works/${ao3WorkId}/img/${IMAGE_SHA}`,
    ...uploadIds.map((u) => `originals/${u}.epub`),
    rawKey,
  ];
  await Promise.all(others.map((key) => env.BUCKET.put(key, "xr1a-bytes")));
  const keys = [...seeded.fragments, ...second.fragments, ...held.fragments]
    .map((f) => f.key)
    .concat(others)
    .sort();
  return { seeded, uploadIds, rawKey, keys };
}

/** Which of `keys` the bucket still holds, sorted. */
async function bucketKeys(keys: string[]) {
  const held = await Promise.all(keys.map(async (k) => ((await env.BUCKET.head(k)) ? k : null)));
  return held.filter((k) => k !== null).sort();
}

/** vitest.config.ts's made-up zone id, which the purge requests name. */
const ZONE = "0123456789abcdef0123456789abcdef";

/** Each form of each upload's download URL, sorted: `.epub` and `.pdf` (the R2 keys) and bare. */
const downloadUrls = (uploadIds: string[]) =>
  uploadIds
    .flatMap((u) => [
      `https://content.rarepair.fans/originals/${u}.epub`,
      `https://content.rarepair.fans/originals/${u}.pdf`,
      `https://content.rarepair.fans/originals/${u}`,
    ])
    .sort();

/**
 * The purge requests naming work `ao3WorkId` (its tag or images prefix) or any of its
 * uploads' download URLs. Other files' requests share the log, so this filters.
 */
async function purgesOf(ao3WorkId: number, uploadIds: string[]): Promise<PurgeRequest[]> {
  const urls = new Set(downloadUrls(uploadIds));
  return (await purgeRequests()).filter(
    (p) =>
      (p.body.tags ?? []).includes(`work-${ao3WorkId}`) ||
      (p.body.prefixes ?? []).includes(`content.rarepair.fans/works/${ao3WorkId}/img/`) ||
      (p.body.files ?? []).some((f) => urls.has(f)),
  );
}

let moderator: string;
let plainUser: string;

beforeAll(async () => {
  moderator = await signInAs("xr1a-moderator@example.test", "moderator");
  plainUser = await signInAs("xr1a-user@example.test", null);
});

describe("18 moderation", () => {
  it("The remove button asks to confirm, naming the work, and changes nothing", async () => {
    const id = W + 1;
    await seedWork(db, { ao3WorkId: id, title: "xr1a-confirm-title" });
    const res = await post(`/admin/works/${id}/remove`, moderator, {
      from: "/admin/reports/xr1a-report",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("xr1a-confirm-title");
    expect(html).toContain(String(id));
    expect(html).toContain(`action="/admin/works/${id}/remove"`);
    expect(html).toContain('name="confirm"');
    expect(html).toContain('name="from" value="/admin/reports/xr1a-report"');
    expect((await workRow(id)).status).toBe("live");
    expect(await purgesOf(id, [])).toEqual([]);
  });

  it("The confirm page escapes the work's title", async () => {
    const id = W + 3;
    await seedWork(db, { ao3WorkId: id, title: "<script>xr1a()</script><form>" });
    const html = await (await post(`/admin/works/${id}/remove`, moderator)).text();
    expect(html).not.toContain("<script>xr1a()");
    expect(html).toContain("&lt;script&gt;xr1a()&lt;/script&gt;&lt;form&gt;");
  });

  it("An unsafe from is dropped from the confirm page and the result page", async () => {
    const id = W + 4;
    await seedWork(db, { ao3WorkId: id });
    for (const from of ["https://evil.example/admin/reports/x", "javascript:alert(1)"]) {
      const posts: Record<string, string>[] = [{ from }, { from, confirm: "yes" }];
      for (const fields of posts) {
        const html = await (await post(`/admin/works/${id}/remove`, moderator, fields)).text();
        expect(html, from).not.toContain('name="from"');
        expect(html, from).not.toContain("Back to the item");
      }
    }
  });

  it("Moderator removes a work", async () => {
    const { seeded, uploadIds, rawKey } = await seedWithObjects(W);
    const neighbour = await seedWithObjects(143001);
    const res = await post(`/admin/works/${W}/remove`, moderator, { confirm: "yes" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain(
      "removed and its files are deleted. Its caches are cleared.",
    );
    expect(await workRow(W)).toMatchObject({ status: "removed", hidden_cause: null });
    expect((await get(`/works/${W}`)).status).toBe(410);
    expect((await env.BUCKET.list({ prefix: `works/${W}/` })).objects).toEqual([]);
    for (const uploadId of uploadIds) {
      expect(await env.BUCKET.get(`originals/${uploadId}.epub`), uploadId).toBeNull();
    }
    expect(await env.BUCKET.get(rawKey)).toBeNull();
    // The neighbour, whose ID starts with W's digits, keeps every object.
    expect(await bucketKeys(neighbour.keys)).toEqual(neighbour.keys);
    const moderatorId = (
      await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", "xr1a-moderator@example.test")
        .executeTakeFirstOrThrow()
    ).id;
    const logged = await db
      .selectFrom("moderation_actions")
      .select(["moderator_id", "action", "target_kind"])
      .where("target_id", "=", seeded.workId)
      .execute();
    expect(logged).toEqual([{ moderator_id: moderatorId, action: "remove", target_kind: "work" }]);
    // Its cached pages and fragments (by tag), images (by prefix) and downloads (by URL)
    // are purged, and the neighbour's are not.
    const purged = await purgesOf(W, uploadIds);
    expect(purged.map((p) => [p.zone, p.authorized])).toEqual([
      [ZONE, true],
      [ZONE, true],
      [ZONE, true],
    ]);
    expect(purged.flatMap((p) => p.body.tags ?? [])).toEqual([`work-${W}`]);
    expect(purged.flatMap((p) => p.body.prefixes ?? [])).toEqual([
      `content.rarepair.fans/works/${W}/img/`,
    ]);
    expect(purged.flatMap((p) => p.body.files ?? []).sort()).toEqual(downloadUrls(uploadIds));
    expect(await purgesOf(143001, neighbour.uploadIds)).toEqual([]);
  });
});

describe("Remove work: who may, and which works", () => {
  it("Non-moderators, signed-out and cross-site posts get 404 and change nothing", async () => {
    const id = W + 10;
    const { keys, uploadIds } = await seedWithObjects(id);
    const crossSite = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    for (const [who, res] of [
      ["plain user", await post(`/admin/works/${id}/remove`, plainUser, { confirm: "yes" })],
      ["signed out", await post(`/admin/works/${id}/remove`, undefined, { confirm: "yes" })],
      [
        "cross-site",
        await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" }, crossSite),
      ],
    ] as const) {
      expect(res.status, who).toBe(404);
    }
    expect((await workRow(id)).status).toBe("live");
    expect(await bucketKeys(keys)).toEqual(keys);
    expect(await purgesOf(id, uploadIds)).toEqual([]);
  });

  it("An unknown work gets 404", async () => {
    for (const id of [String(W + 99), "0", "x", "2147483648", "99999999999"]) {
      expect(
        (await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" })).status,
        id,
      ).toBe(404);
    }
  });

  it("A hidden work can be removed", async () => {
    const id = W + 11;
    await seedWithObjects(id, true);
    expect((await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" })).status).toBe(
      200,
    );
    expect(await workRow(id)).toMatchObject({ status: "removed", hidden_cause: null });
    expect((await env.BUCKET.list({ prefix: `works/${id}/` })).objects).toEqual([]);
  });

  it("A processing work is refused and keeps its files", async () => {
    const id = W + 12;
    const { seeded, keys, uploadIds } = await seedWithObjects(id);
    await db
      .updateTable("works")
      .set({ status: "processing" })
      .where("id", "=", seeded.workId)
      .execute();
    const res = await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing changed");
    expect((await workRow(id)).status).toBe("processing");
    expect(await bucketKeys(keys)).toEqual(keys);
    expect(await purgesOf(id, uploadIds)).toEqual([]);
  });

  it("A repeat remove deletes the files again, purges again and writes no second row", async () => {
    const id = W + 13;
    const { seeded, uploadIds } = await seedWithObjects(id);
    await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" });
    // Bytes a failed delete, or a late ingest job, left behind.
    await env.BUCKET.put(`works/${id}/img/${IMAGE_SHA}`, "xr1a-leftover");
    const res = await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("deleted again");
    expect((await env.BUCKET.list({ prefix: `works/${id}/` })).objects).toEqual([]);
    const logged = await db
      .selectFrom("moderation_actions")
      .select("id")
      .where("target_id", "=", seeded.workId)
      .execute();
    expect(logged).toHaveLength(1);
    const tags = (await purgesOf(id, uploadIds)).flatMap((p) => p.body.tags ?? []);
    expect(tags).toEqual([`work-${id}`, `work-${id}`]);
  });

  it("A failed purge says so with a 502, and the work stays removed with its files deleted", async () => {
    for (const [id, fail] of [
      [W + 15, 503],
      [W + 16, "not-accepted"],
    ] as const) {
      const { uploadIds } = await seedWithObjects(id);
      await failNextPurge(`work-${id}`, fail);
      const res = await post(`/admin/works/${id}/remove`, moderator, {
        confirm: "yes",
        from: "/admin/reports/xr1b-report",
      });
      expect(res.status, String(fail)).toBe(502);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toMatch(/'nonce-[^']+'/);
      const html = await res.text();
      expect(html).toContain("clearing the caches failed");
      expect(html).toContain("Remove again");
      expect(html).toContain('href="/admin/reports/xr1b-report"');
      expect(await workRow(id)).toMatchObject({ status: "removed", hidden_cause: null });
      expect((await env.BUCKET.list({ prefix: `works/${id}/` })).objects).toEqual([]);
      // The images and downloads were still asked for.
      const purged = await purgesOf(id, uploadIds);
      expect(purged.flatMap((p) => p.body.prefixes ?? [])).toHaveLength(1);
      expect(purged.flatMap((p) => p.body.files ?? []).sort()).toEqual(downloadUrls(uploadIds));
      // Remove again retries, and this time the purge is accepted.
      const retry = await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" });
      expect(retry.status).toBe(200);
      expect(await retry.text()).toContain("deleted again and its caches cleared");
      const tags = (await purgesOf(id, uploadIds)).flatMap((p) => p.body.tags ?? []);
      expect(tags).toEqual([`work-${id}`, `work-${id}`]);
    }
  });

  it("Every work action list offers the remove button", async () => {
    const id = W + 14;
    await seedWork(db, { ao3WorkId: id });
    const html = await (await get(`/admin/works/${id}`, moderator)).text();
    expect(html).toMatch(
      new RegExp(`<form method="post" action="/admin/works/${id}/remove">.*Remove work</button>`),
    );
  });
});

describe("09 content origin", () => {
  it("Removed work's images and downloads stop being served", async () => {
    const id = W + 2;
    const { uploadIds } = await seedWithObjects(id);
    await post(`/admin/works/${id}/remove`, moderator, { confirm: "yes" });
    expect(await env.BUCKET.get(`works/${id}/img/${IMAGE_SHA}`)).toBeNull();
    for (const uploadId of uploadIds) {
      expect(await env.BUCKET.get(`originals/${uploadId}.epub`), uploadId).toBeNull();
    }
    // The images and download URLs are purged from the cache.
    const purged = await purgesOf(id, uploadIds);
    expect(purged.flatMap((p) => p.body.prefixes ?? [])).toEqual([
      `content.rarepair.fans/works/${id}/img/`,
    ]);
    expect(purged.flatMap((p) => p.body.files ?? []).sort()).toEqual(downloadUrls(uploadIds));
  });
});
