import { createDb } from "@archive/db";
import { putFragments, seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, fetchW, signIn } from "./helpers";

// One database serves every test file in the run, and the queue lists every work that
// needs a check. So this file keeps to AO3 work IDs 19500 to 19599, names every title and
// marker with a "mod3b-" prefix and dates its triggers in 1999 so they sort ahead of
// anyone else's. Text is synthetic.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const NOTICE = "Chapters may be imperfect; a moderator will check.";
// A reader with a settings cookie, whose chapter pages skip the 60 s edge cache.
const READER = "__Host-reader=theme=dark";

let moderator: string;
let plainUser: string;

async function signInWithRole(email: string, role: string | null): Promise<string> {
  const cookie = await signIn(email);
  await db
    .updateTable("user")
    .set({ role, terms_accepted_at: new Date() })
    .where("email", "=", email)
    .execute();
  return cookie;
}

beforeAll(async () => {
  moderator = await signInWithRole("mod3b-moderator@example.test", "moderator");
  plainUser = await signInWithRole("mod3b-user@example.test", null);
});

const get = (path: string, cookie?: string) =>
  fetchW(path, { headers: cookie === undefined ? {} : { cookie } });

/** A form post as the site's own page makes it. */
const post = (path: string, cookie?: string, fields: Record<string, string> = {}) => {
  const headers = new Headers({
    origin: BASE,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (cookie !== undefined) headers.set("cookie", cookie);
  return fetchW(path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};

const queued = async (ao3WorkId: number) => {
  const res = await get("/admin/works", moderator);
  expect(res.status).toBe(200);
  return (await res.text()).includes(`href="/admin/works/${ao3WorkId}"`);
};

const logged = (targetId: string) =>
  db
    .selectFrom("moderation_actions")
    .innerJoin("user", "user.id", "moderation_actions.moderator_id")
    .select([
      "user.email",
      "moderation_actions.action",
      "moderation_actions.target_kind",
      "moderation_actions.note",
    ])
    .where("moderation_actions.target_id", "=", targetId)
    .execute();

const currentOf = async (ao3WorkId: number) =>
  (
    await db
      .selectFrom("works")
      .select("current_version_id")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirstOrThrow()
  ).current_version_id;

const reportOn = (work: { workId: string; userId: string }, kind: string, status = "open") =>
  db
    .insertInto("reports")
    .values({ work_id: work.workId, reporter_id: work.userId, kind, status })
    .execute();

const openReports = async (workId: string, kind = "wrong_version") =>
  (
    await db
      .selectFrom("reports")
      .select("id")
      .where("work_id", "=", workId)
      .where("kind", "=", kind)
      .where("status", "=", "open")
      .execute()
  ).length;

/** The `<tr>` of the page whose text includes `marker`. */
function rowWith(html: string, marker: string): string {
  const rows = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const row = rows.find((r) => r.includes(marker));
  expect(row, marker).toBeDefined();
  return row ?? "";
}

describe("18 moderation: Works to check detail page", () => {
  it("Works to check detail page has its own actions", async () => {
    // F: flagged, HV: live v1 and a held v2, BV: replaced by a wrong v2 and reported.
    const f = await seedWork(db, {
      ao3WorkId: 19501,
      title: "mod3b-flagged",
      reviewReasons: ["mod3b-reason-a", "mod3b-reason-b"],
      addedAt: "1999-01-01T00:00:00Z",
    });
    const hv = await seedWork(db, {
      ao3WorkId: 19502,
      title: "mod3b-held",
      addedAt: "1999-01-02T00:00:00Z",
    });
    const held = await seedVersion(db, hv, {
      current: false,
      holdReason: "chapters_changed",
      addedAt: "1999-02-02T00:00:00Z",
    });
    const bv = await seedWork(db, {
      ao3WorkId: 19503,
      title: "mod3b-wrong",
      addedAt: "1999-01-03T00:00:00Z",
    });
    await seedVersion(db, bv, { addedAt: "1999-02-03T00:00:00Z" });
    await reportOn(bv, "wrong_version");
    await reportOn(bv, "wrong_version");

    for (const [id, title] of [
      [19501, "mod3b-flagged"],
      [19502, "mod3b-held"],
      [19503, "mod3b-wrong"],
    ] as const) {
      const res = await get(`/admin/works/${id}`, moderator);
      expect(res.status, title).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html, title).not.toMatch(/<script/i);
      for (const action of ["current", "hide", "restore", "remove"]) {
        expect(html, `${title} ${action}`).toContain(`action="/admin/works/${id}/${action}"`);
      }
      // The result pages link back to this page.
      expect(html, title).toContain(`name="from" value="/admin/works/${id}"`);
    }

    // F: the current version's review reasons, unchecked, with an Approve form.
    const flagged = rowWith(
      await (await get("/admin/works/19501", moderator)).text(),
      "1999-01-01",
    );
    expect(flagged).toContain("mod3b-reason-a, mod3b-reason-b");
    expect(flagged).toContain("Not checked");
    expect(flagged).toContain(`action="/admin/works/19501/approve"`);
    expect(flagged).toContain(`name="version" value="${f.versionId}"`);

    // HV: the held version shows its hold reason and an Approve form, and no Make current.
    const html = await (await get("/admin/works/19502", moderator)).text();
    const heldRow = rowWith(html, "1999-02-02");
    expect(heldRow).toContain("chapters_changed");
    expect(heldRow).toContain(`action="/admin/works/19502/approve"`);
    expect(heldRow).toContain(`name="version" value="${held.versionId}"`);
    expect(heldRow).not.toContain(`action="/admin/works/19502/current"`);
    // The live version needs no check: no Approve form.
    expect(rowWith(html, "1999-01-02")).not.toContain("/approve");

    // BV: the open reports and the form that closes them.
    const wrong = await (await get("/admin/works/19503", moderator)).text();
    expect(wrong).toContain("Open reports that a version is wrong: 2");
    expect(wrong).toContain(`action="/admin/works/19503/reports/close"`);
    expect(html).not.toContain("/reports/close");

    // Only a moderator sees it.
    for (const cookie of [plainUser, undefined]) {
      expect((await get("/admin/works/19501", cookie)).status).toBe(404);
    }
  });
});

describe("18 moderation: approving", () => {
  it("Approving a flagged work clears the notice", async () => {
    const f = await seedWork(db, {
      ao3WorkId: 19510,
      title: "mod3b-notice",
      reviewReasons: ["mod3b-reason"],
      chapters: [{ html: "<p>mod3b-notice-one</p>" }],
      addedAt: "1999-01-10T00:00:00Z",
    });
    await putFragments(env.BUCKET, f.fragments);
    expect(await (await get("/works/19510/chapters/1", READER)).text()).toContain(NOTICE);
    expect(await (await get("/works/19510")).text()).toContain(NOTICE);
    expect(await queued(19510)).toBe(true);

    const res = await post("/admin/works/19510/approve", moderator, { version: f.versionId });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("The notice is cleared.");
    expect(await (await get("/works/19510/chapters/1", READER)).text()).not.toContain(NOTICE);
    expect(await (await get("/works/19510")).text()).not.toContain(NOTICE);
    expect(await queued(19510)).toBe(false);
    expect(await logged(f.versionId)).toEqual([
      {
        email: "mod3b-moderator@example.test",
        action: "approve",
        target_kind: "version",
        note: null,
      },
    ]);
    // A second approval changes nothing and logs nothing.
    const again = await post("/admin/works/19510/approve", moderator, { version: f.versionId });
    expect(await again.text()).toContain("Nothing changed");
    expect(await logged(f.versionId)).toHaveLength(1);
    // The page no longer offers it.
    const page = await (await get("/admin/works/19510", moderator)).text();
    expect(page).not.toContain("/approve");
  });

  it("Approving a held version publishes it", async () => {
    const first = await seedWork(db, {
      ao3WorkId: 19520,
      title: "mod3b-hv-first",
      chapters: [{ html: "<p>mod3b-hv-v1</p>" }],
      addedAt: "1999-01-20T00:00:00Z",
    });
    const held = await seedVersion(db, first, {
      current: false,
      title: "mod3b-hv-second",
      reviewReasons: ["mod3b-reason"],
      chapters: [{ html: "<p>mod3b-hv-v2-one</p>" }, { html: "<p>mod3b-hv-v2-two</p>" }],
      addedAt: "1999-02-20T00:00:00Z",
    });
    await putFragments(env.BUCKET, [...first.fragments, ...held.fragments]);
    expect(await queued(19520)).toBe(true);
    expect(await (await get("/works/19520/chapters/1", READER)).text()).toContain("mod3b-hv-v1");

    const res = await post("/admin/works/19520/approve", moderator, { version: held.versionId });

    expect(await res.text()).toContain("That version is approved and now current.");
    expect(await currentOf(19520)).toBe(held.versionId);
    const chapter = await (await get("/works/19520/chapters/2", READER)).text();
    expect(chapter).toContain("mod3b-hv-v2-two");
    expect(chapter).not.toContain(NOTICE);
    const upload = await db
      .selectFrom("work_versions")
      .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
      .select(["uploads.status", "work_versions.hold_reason"])
      .where("work_versions.id", "=", held.versionId)
      .executeTakeFirstOrThrow();
    expect(upload).toEqual({ status: "live", hold_reason: "chapters_changed" });
    const work = await db
      .selectFrom("works")
      .select(["title", "chapters_count"])
      .where("ao3_work_id", "=", 19520)
      .executeTakeFirstOrThrow();
    expect(work).toEqual({ title: "mod3b-hv-second", chapters_count: 2 });
    expect(await queued(19520)).toBe(false);
    // One log row: the approve, not a make_current as well.
    expect(await logged(held.versionId)).toEqual([
      {
        email: "mod3b-moderator@example.test",
        action: "approve",
        target_kind: "version",
        note: null,
      },
    ]);
    const again = await post("/admin/works/19520/approve", moderator, { version: held.versionId });
    expect(await again.text()).toContain("Nothing changed");
    expect(await logged(held.versionId)).toHaveLength(1);
  });

  it("A flagged backfill version is never held and can be approved", async () => {
    const w = await seedWork(db, {
      ao3WorkId: 19535,
      title: "mod3b-backfill",
      addedAt: "1999-01-25T00:00:00Z",
    });
    // Re-made from the first upload, so it has none of its own.
    const remade = await seedVersion(db, w, {
      backfillOf: w.uploadId,
      reviewReasons: ["mod3b-reason"],
      addedAt: "1999-02-25T00:00:00Z",
    });
    const html = await (await get("/admin/works/19535", moderator)).text();
    const row = rowWith(html, "1999-02-25");
    expect(row).not.toContain("Held for review");
    expect(row).toContain(`action="/admin/works/19535/approve"`);
    expect(row).toContain(`action="/admin/works/19535/current"`);

    const res = await post("/admin/works/19535/approve", moderator, { version: remade.versionId });

    expect(await res.text()).toContain("The notice is cleared.");
    expect(await queued(19535)).toBe(false);
  });

  it("Approve refuses what it can't approve and answers 404 to the rest", async () => {
    const w = await seedWork(db, {
      ao3WorkId: 19530,
      title: "mod3b-refuse",
      addedAt: "1999-01-30T00:00:00Z",
    });
    const replaced = await seedVersion(db, w, {
      reviewReasons: ["mod3b-reason"],
      addedAt: "1999-02-01T00:00:00Z",
    });
    const older = await seedVersion(db, w, { addedAt: "1999-02-02T00:00:00Z" });
    const other = await seedWork(db, {
      ao3WorkId: 19531,
      title: "mod3b-refuse-other",
      reviewReasons: ["mod3b-reason"],
    });
    const before = await currentOf(19530);

    // A live version that is not flagged, a flagged one that is not current: nothing changes.
    for (const version of [w.versionId, replaced.versionId]) {
      const res = await post("/admin/works/19530/approve", moderator, { version });
      expect(res.status, version).toBe(200);
      expect(await res.text()).toContain("Nothing changed");
    }
    // Another work's version, an unknown one, malformed ones, no field, an unknown work.
    for (const version of [other.versionId, "mod3b-no-such", "mod3b\0nul", "", "x".repeat(65)]) {
      expect((await post("/admin/works/19530/approve", moderator, { version })).status).toBe(404);
    }
    expect((await post("/admin/works/19530/approve", moderator)).status).toBe(404);
    expect(
      (await post("/admin/works/19599/approve", moderator, { version: older.versionId })).status,
    ).toBe(404);
    expect(await currentOf(19530)).toBe(before);

    // A removed work: refused, nothing written.
    await db
      .updateTable("works")
      .set({ status: "removed" })
      .where("ao3_work_id", "=", 19531)
      .execute();
    const removed = await post("/admin/works/19531/approve", moderator, {
      version: other.versionId,
    });
    expect(await removed.text()).toContain("removed");
    // Its reports can't be closed, so the page doesn't offer to.
    await reportOn(other, "wrong_version");
    expect(await (await get("/admin/works/19531", moderator)).text()).not.toContain(
      "/reports/close",
    );
    const row = await db
      .selectFrom("work_versions")
      .select("checked_at")
      .where("id", "=", other.versionId)
      .executeTakeFirstOrThrow();
    expect(row.checked_at).toBeNull();
    for (const id of [w.versionId, replaced.versionId, other.versionId]) {
      expect(await logged(id), id).toEqual([]);
    }
  });

  it("Only a moderator can approve, from this site", async () => {
    const w = await seedWork(db, {
      ao3WorkId: 19540,
      title: "mod3b-gate",
      reviewReasons: ["mod3b-reason"],
      addedAt: "1999-01-31T00:00:00Z",
    });
    for (const cookie of [plainUser, undefined]) {
      const res = await post("/admin/works/19540/approve", cookie, { version: w.versionId });
      expect(res.status).toBe(404);
      const close = await post("/admin/works/19540/reports/close", cookie);
      expect(close.status).toBe(404);
    }
    const crossSite = await fetchW("/admin/works/19540/approve", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
        cookie: moderator,
      },
      body: new URLSearchParams({ version: w.versionId }).toString(),
    });
    expect(crossSite.status).toBe(404);
    // The close route is behind the same check, and so is a post that names no origin.
    await reportOn(w, "wrong_version");
    const refused: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      {},
    ];
    for (const headers of refused) {
      const res = await fetchW("/admin/works/19540/reports/close", {
        method: "POST",
        headers: { ...headers, cookie: moderator },
      });
      expect(res.status, JSON.stringify(headers)).toBe(404);
    }
    expect(await openReports(w.workId)).toBe(1);
    expect(await queued(19540)).toBe(true);
    expect(await logged(w.versionId)).toEqual([]);
  });
});

describe("18 moderation: making current and wrong-version reports", () => {
  it("Making a version current from Works to check", async () => {
    const bv = await seedWork(db, {
      ao3WorkId: 19550,
      title: "mod3b-bv-first",
      chapters: [{ html: "<p>mod3b-bv-v1-one</p>" }],
      addedAt: "1999-01-05T00:00:00Z",
    });
    const second = await seedVersion(db, bv, {
      chapters: [{ html: "<p>mod3b-bv-v2-one</p>" }],
      addedAt: "1999-02-05T00:00:00Z",
    });
    await putFragments(env.BUCKET, [...bv.fragments, ...second.fragments]);
    await reportOn(bv, "wrong_version");
    await reportOn(bv, "wrong_version", "closed");
    await reportOn(bv, "mod3b-other-kind");
    expect(await queued(19550)).toBe(true);
    expect(await currentOf(19550)).toBe(second.versionId);

    const res = await post("/admin/works/19550/current", moderator, { version: bv.versionId });

    expect(await res.text()).toContain("That version is now current.");
    expect(await currentOf(19550)).toBe(bv.versionId);
    expect(await (await get("/works/19550/chapters/1", READER)).text()).toContain(
      "mod3b-bv-v1-one",
    );
    // The reports were about the version it replaced.
    expect(await openReports(bv.workId)).toBe(0);
    expect(await openReports(bv.workId, "mod3b-other-kind")).toBe(1);
    expect(await queued(19550)).toBe(false);
    expect(await logged(bv.versionId)).toEqual([
      {
        email: "mod3b-moderator@example.test",
        action: "make_current",
        target_kind: "version",
        note: null,
      },
    ]);
  });

  it("Close wrong-version reports takes the work off Works to check", async () => {
    const w = await seedWork(db, {
      ao3WorkId: 19560,
      title: "mod3b-close",
      addedAt: "1999-01-06T00:00:00Z",
    });
    await reportOn(w, "wrong_version");
    await reportOn(w, "wrong_version");
    await reportOn(w, "wrong_version", "closed");
    await reportOn(w, "mod3b-other-kind");
    expect(await queued(19560)).toBe(true);

    const res = await post("/admin/works/19560/reports/close", moderator);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Closed 2 reports");
    expect(await openReports(w.workId)).toBe(0);
    expect(await openReports(w.workId, "mod3b-other-kind")).toBe(1);
    expect(await queued(19560)).toBe(false);
    expect(await logged(w.workId)).toEqual([
      {
        email: "mod3b-moderator@example.test",
        action: "reject",
        target_kind: "work",
        note: "wrong_version reports",
      },
    ]);
    const again = await post("/admin/works/19560/reports/close", moderator);
    expect(await again.text()).toContain("Nothing changed");
    expect(await logged(w.workId)).toHaveLength(1);
    expect((await post("/admin/works/19598/reports/close", moderator)).status).toBe(404);
  });
});
