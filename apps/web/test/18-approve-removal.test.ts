import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, failNextPurge, fetchW, purgeRequests, signIn } from "./helpers";

// One database and one bucket serve every test file in the run. This file keeps to AO3
// work IDs 40200 to 40299 and gives every marker an "xr2-" prefix. Text is synthetic.
const W = 40200;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

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

const IMAGE_SHA = "cd".repeat(32);

/** A work with its objects in R2: fragments, an image, the original and the raw upload. */
async function seedWithObjects(
  ao3WorkId: number,
  opts: {
    status?: "live" | "hidden" | "removed";
    hiddenCause?: "removal_request" | "reports";
  } = {},
) {
  const status = opts.status ?? "hidden";
  const seeded = await seedWork(db, {
    ao3WorkId,
    title: `xr2-title-${ao3WorkId}`,
    chapters: [{ html: "<p>xr2-one</p>" }],
    status,
    hiddenCause: status === "hidden" ? (opts.hiddenCause ?? "removal_request") : undefined,
  });
  await putFragments(env.BUCKET, seeded.fragments);
  const rawKey = `uploads/${seeded.uploadId}`;
  await db
    .updateTable("uploads")
    .set({ r2_key: rawKey })
    .where("id", "=", seeded.uploadId)
    .execute();
  const others = [
    `works/${ao3WorkId}/img/${IMAGE_SHA}`,
    `originals/${seeded.uploadId}.epub`,
    rawKey,
  ];
  await Promise.all(others.map((key) => env.BUCKET.put(key, "xr2-bytes")));
  const keys = seeded.fragments
    .map((f) => f.key)
    .concat(others)
    .sort();
  return { seeded, keys, rawKey };
}

async function bucketKeys(keys: string[]) {
  const held = await Promise.all(keys.map(async (k) => ((await env.BUCKET.head(k)) ? k : null)));
  return held.filter((k) => k !== null).sort();
}

const workId = async (ao3: number) =>
  (
    await db
      .selectFrom("works")
      .select("id")
      .where("ao3_work_id", "=", ao3)
      .executeTakeFirstOrThrow()
  ).id;

const workStatus = async (ao3: number) =>
  (
    await db
      .selectFrom("works")
      .select("status")
      .where("ao3_work_id", "=", ao3)
      .executeTakeFirstOrThrow()
  ).status;

async function addRequest(id: string, work: string | null, kind: "remove_work" | "opt_out") {
  await db
    .insertInto("requests")
    .values({
      id,
      kind,
      work_id: work,
      pseud_norm: work === null ? `${id}-pseud` : null,
      contact_email: `${id}@example.test`,
      statement: `${id}-statement`,
      ip_hash: "xr2-ip-hash",
    })
    .execute();
}

async function addTakedown(id: string, work: string) {
  await db
    .insertInto("takedowns")
    .values({
      id,
      work_id: work,
      requester: `${id}@example.test`,
      basis: `${id}-basis`,
      signature: `${id}-signature`,
      infringing_material: `${id}-material`,
      good_faith: true,
      accuracy_authority: true,
      incomplete: false,
    })
    .execute();
}

const statusOf = async (table: "requests" | "takedowns", id: string) =>
  (await db.selectFrom(table).select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const logFor = (targetId: string) =>
  db
    .selectFrom("moderation_actions")
    .select(["action", "target_kind", "note"])
    .where("target_id", "=", targetId)
    .orderBy("created_at")
    .execute();

let moderator: string;
let plainUser: string;

beforeAll(async () => {
  moderator = await signInAs("xr2-moderator@example.test", "moderator");
  plainUser = await signInAs("xr2-user@example.test", null);
});

describe("16 removal and opt-out", () => {
  it("Approved removal really removes", async () => {
    const ao3 = W + 1;
    const { seeded, keys } = await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await addRequest("xr2-req-1", wid, "remove_work");

    // The first post only asks to confirm.
    const ask = await post("/admin/requests/xr2-req-1/approve", moderator);
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain('name="confirm"');
    expect(await statusOf("requests", "xr2-req-1")).toBe("pending");
    expect(await bucketKeys(keys)).toEqual(keys);

    const res = await post("/admin/requests/xr2-req-1/approve", moderator, { confirm: "yes" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The work is removed");
    expect(await workStatus(ao3)).toBe("removed");
    expect(await bucketKeys(keys)).toEqual([]);
    const purged = await purgeRequests();
    expect(purged.flatMap((p) => p.body.tags ?? [])).toContain(`work-${ao3}`);
    expect(purged.flatMap((p) => p.body.prefixes ?? [])).toContain(
      `content.rarepair.fans/works/${ao3}/img/`,
    );
    expect(purged.flatMap((p) => p.body.files ?? [])).toContain(
      `https://content.rarepair.fans/originals/${seeded.uploadId}.epub`,
    );
    const page = await get(`/works/${ao3}`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This work has been removed");
    expect(await statusOf("requests", "xr2-req-1")).toBe("approved");
    expect(await logFor("xr2-req-1")).toEqual([
      { action: "approve", target_kind: "request", note: null },
    ]);
    expect((await logFor(wid)).map((r) => r.action)).toEqual(["remove"]);
  });

  it("An approve of an opt-out request removes nothing", async () => {
    const ao3 = W + 2;
    await seedWithObjects(ao3, { status: "live" });
    await addRequest("xr2-optout", null, "opt_out");
    const res = await post("/admin/requests/xr2-optout/approve", moderator, { confirm: "yes" });
    expect(res.status).toBe(404);
    expect(await statusOf("requests", "xr2-optout")).toBe("pending");
    expect(await workStatus(ao3)).toBe("live");
  });

  it("A rejected or already approved request is not approved again", async () => {
    const ao3 = W + 3;
    const { keys } = await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await addRequest("xr2-req-rejected", wid, "remove_work");
    await post("/admin/requests/xr2-req-rejected/reject", moderator);
    const res = await post("/admin/requests/xr2-req-rejected/approve", moderator, {
      confirm: "yes",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing changed");
    expect(await statusOf("requests", "xr2-req-rejected")).toBe("rejected");
    expect(await bucketKeys(keys)).toEqual(keys);
    expect(await workStatus(ao3)).not.toBe("removed");

    // A replayed approve changes nothing and logs nothing more.
    await addRequest("xr2-req-twice", wid, "remove_work");
    await post("/admin/requests/xr2-req-twice/approve", moderator, { confirm: "yes" });
    const before = await logFor("xr2-req-twice");
    const again = await post("/admin/requests/xr2-req-twice/approve", moderator, {
      confirm: "yes",
    });
    expect(await again.text()).toContain("Nothing changed");
    expect(await logFor("xr2-req-twice")).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("A work still processing leaves the request pending", async () => {
    const ao3 = W + 4;
    const { keys } = await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await db
      .updateTable("works")
      .set({ status: "processing", hidden_cause: null })
      .where("id", "=", wid)
      .execute();
    await addRequest("xr2-req-processing", wid, "remove_work");
    const res = await post("/admin/requests/xr2-req-processing/approve", moderator, {
      confirm: "yes",
    });
    expect(await res.text()).toContain("still processing");
    expect(await statusOf("requests", "xr2-req-processing")).toBe("pending");
    expect(await workStatus(ao3)).toBe("processing");
    expect(await bucketKeys(keys)).toEqual(keys);
    expect(await logFor("xr2-req-processing")).toEqual([]);
  });

  it("A work already removed is marked and its files deleted again, with no second remove row", async () => {
    const ao3 = W + 5;
    const { keys } = await seedWithObjects(ao3, { status: "removed" });
    const wid = await workId(ao3);
    await addRequest("xr2-req-gone", wid, "remove_work");
    const res = await post("/admin/requests/xr2-req-gone/approve", moderator, { confirm: "yes" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("already removed");
    expect(await statusOf("requests", "xr2-req-gone")).toBe("approved");
    expect(await bucketKeys(keys)).toEqual([]);
    expect((await logFor(wid)).filter((r) => r.action === "remove")).toEqual([]);
  });

  it("A failed purge still marks the request and says so with a 502", async () => {
    const ao3 = W + 6;
    const { keys } = await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await addRequest("xr2-req-purge", wid, "remove_work");
    await failNextPurge(`work-${ao3}`, 500);
    const res = await post("/admin/requests/xr2-req-purge/approve", moderator, { confirm: "yes" });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("clearing the caches failed");
    expect(await workStatus(ao3)).toBe("removed");
    expect(await bucketKeys(keys)).toEqual([]);
    expect(await statusOf("requests", "xr2-req-purge")).toBe("approved");
  });

  it("Other pending requests for the work stay pending", async () => {
    const ao3 = W + 7;
    await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await addRequest("xr2-req-a", wid, "remove_work");
    await addRequest("xr2-req-b", wid, "remove_work");
    await post("/admin/requests/xr2-req-a/approve", moderator, { confirm: "yes" });
    expect(await statusOf("requests", "xr2-req-b")).toBe("pending");
  });

  it("Only a moderator, from the site itself, can approve", async () => {
    const ao3 = W + 8;
    const { keys } = await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await addRequest("xr2-req-auth", wid, "remove_work");
    await addTakedown("xr2-td-auth", wid);
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    for (const path of [
      "/admin/requests/xr2-req-auth/approve",
      "/admin/takedowns/xr2-td-auth/approve",
    ]) {
      expect((await post(path, undefined, { confirm: "yes" })).status, path).toBe(404);
      expect((await post(path, plainUser, { confirm: "yes" })).status, path).toBe(404);
      expect((await post(path, moderator, { confirm: "yes" }, cross)).status, path).toBe(404);
    }
    expect(await statusOf("requests", "xr2-req-auth")).toBe("pending");
    expect(await statusOf("takedowns", "xr2-td-auth")).toBe("pending");
    expect(await bucketKeys(keys)).toEqual(keys);
  });

  it("A pending item's page offers Approve, a request about a pseud does not", async () => {
    const ao3 = W + 9;
    await seedWithObjects(ao3);
    const wid = await workId(ao3);
    await addRequest("xr2-req-page", wid, "remove_work");
    await addRequest("xr2-optout-page", null, "opt_out");
    await addTakedown("xr2-td-page", wid);
    const html = (path: string) => get(path, moderator).then((r) => r.text());
    expect(await html("/admin/requests/xr2-req-page")).toContain(
      'action="/admin/requests/xr2-req-page/approve"',
    );
    expect(await html("/admin/takedowns/xr2-td-page")).toContain(
      'action="/admin/takedowns/xr2-td-page/approve"',
    );
    expect(await html("/admin/requests/xr2-optout-page")).not.toContain("/approve");
  });
});

describe("17 reports and DMCA", () => {
  it("Takedown approval removes the work", async () => {
    const ao3 = W + 20;
    const { keys } = await seedWithObjects(ao3, { status: "live" });
    const wid = await workId(ao3);
    await addTakedown("xr2-td-1", wid);
    // A pending notice alone does not take the work down.
    expect(await workStatus(ao3)).toBe("live");

    const ask = await post("/admin/takedowns/xr2-td-1/approve", moderator);
    expect(await ask.text()).toContain('name="confirm"');
    expect(await workStatus(ao3)).toBe("live");

    const res = await post("/admin/takedowns/xr2-td-1/approve", moderator, { confirm: "yes" });
    expect(res.status).toBe(200);
    expect(await bucketKeys(keys)).toEqual([]);
    const purged = await purgeRequests();
    expect(purged.flatMap((p) => p.body.tags ?? [])).toContain(`work-${ao3}`);
    expect((await get(`/works/${ao3}`)).status).toBe(410);
    // The takedown list ingest reads: a `removed` takedown on a `removed` work.
    const listed = await db
      .selectFrom("takedowns")
      .innerJoin("works", "works.id", "takedowns.work_id")
      .select(["takedowns.status as takedown", "works.status as work", "works.ao3_work_id"])
      .where("takedowns.id", "=", "xr2-td-1")
      .executeTakeFirstOrThrow();
    expect(listed).toEqual({ takedown: "removed", work: "removed", ao3_work_id: ao3 });
    const decided = await db
      .selectFrom("takedowns")
      .select("resolved_by")
      .where("id", "=", "xr2-td-1")
      .executeTakeFirstOrThrow();
    expect(decided.resolved_by).not.toBeNull();
    expect(await logFor("xr2-td-1")).toEqual([
      { action: "approve", target_kind: "takedown", note: null },
    ]);
  });

  it("A hidden work is removed by a takedown approval", async () => {
    const ao3 = W + 21;
    await seedWithObjects(ao3, { status: "hidden", hiddenCause: "reports" });
    await addTakedown("xr2-td-hidden", await workId(ao3));
    await post("/admin/takedowns/xr2-td-hidden/approve", moderator, { confirm: "yes" });
    expect(await workStatus(ao3)).toBe("removed");
    expect(await statusOf("takedowns", "xr2-td-hidden")).toBe("removed");
  });

  it("A rejected takedown is not approved", async () => {
    const ao3 = W + 22;
    const { keys } = await seedWithObjects(ao3, { status: "live" });
    await addTakedown("xr2-td-rejected", await workId(ao3));
    await post("/admin/takedowns/xr2-td-rejected/reject", moderator);
    const res = await post("/admin/takedowns/xr2-td-rejected/approve", moderator, {
      confirm: "yes",
    });
    expect(await res.text()).toContain("Nothing changed");
    expect(await statusOf("takedowns", "xr2-td-rejected")).toBe("rejected");
    expect(await workStatus(ao3)).toBe("live");
    expect(await bucketKeys(keys)).toEqual(keys);
  });

  it("An unknown takedown or request is not found", async () => {
    for (const path of ["/admin/takedowns/xr2-none/approve", "/admin/requests/xr2-none/approve"]) {
      expect((await post(path, moderator, { confirm: "yes" })).status, path).toBe(404);
    }
  });
});
