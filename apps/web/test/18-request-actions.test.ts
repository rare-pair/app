import { createDb, normalizePseud } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, fetchW, signIn } from "./helpers";

// One database serves every test file in the run. This file keeps to AO3 work IDs 40300 to
// 40399 and gives every row an id, email, IP hash or pseud starting "mod5-". Text is synthetic.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

async function signInAs(email: string, role: string | null): Promise<string> {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role }).where("email", "=", email).execute();
  return cookie;
}

const get = (path: string, cookie?: string) =>
  fetchW(path, { headers: cookie === undefined ? {} : { cookie } });

/** A form post as the site's own page makes it. */
const post = (path: string, cookie?: string) => {
  const headers = new Headers({
    origin: BASE,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (cookie !== undefined) headers.set("cookie", cookie);
  return fetchW(path, { method: "POST", headers, body: "" });
};

let moderator: string;
let plainUser: string;
let moderatorId: string;
/** A live work for the requests a test needs only as relatives. */
let filler: string;

beforeAll(async () => {
  moderator = await signInAs("mod5-moderator@example.test", "moderator");
  plainUser = await signInAs("mod5-user@example.test", null);
  filler = await seed(40399);
  moderatorId = (
    await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", "mod5-moderator@example.test")
      .executeTakeFirstOrThrow()
  ).id;
});

type Hidden = "removal_request" | "moderator" | "reports";

/** A work, by AO3 work ID; its database id comes back. Hidden by `hidden`, or live. */
async function seed(ao3WorkId: number, hidden?: Hidden, pseuds: string[] = ["mod5-author"]) {
  const seeded = await seedWork(db, {
    ao3WorkId,
    title: `mod5-title-${ao3WorkId}`,
    status: hidden === undefined ? "live" : "hidden",
    hiddenCause: hidden,
    authors: pseuds.map((pseud) => ({ pseud, ao3_user: null })),
  });
  return seeded.workId;
}

interface RequestOptions {
  work?: string;
  /** The pseud of an opt-out, which also gets an active `optouts` row. */
  pseud?: string;
  /** Rows in `request_works`: the works this request hid. */
  hid?: string[];
  email?: string;
  ip?: string;
  status?: string;
  optOutActive?: boolean;
  created?: string;
}

/** A request as `/remove` stores it, written straight to the tables. */
async function addRequest(id: string, o: RequestOptions) {
  const optOut = o.pseud !== undefined;
  await db
    .insertInto("requests")
    .values({
      id,
      kind: optOut ? "opt_out" : "remove_work",
      work_id: o.work ?? (optOut ? null : filler),
      pseud_norm: optOut ? normalizePseud(o.pseud!) : null,
      contact_email: o.email ?? `${id}@example.test`,
      statement: `${id}-statement`,
      ip_hash: o.ip ?? `mod5-ip-${id}`,
      status: o.status ?? "pending",
      created_at: o.created ?? "2001-06-01T00:00:00Z",
    })
    .execute();
  if (optOut) {
    await db
      .insertInto("optouts")
      .values({
        pseud_norm: normalizePseud(o.pseud!),
        request_id: id,
        active: o.optOutActive ?? true,
      })
      .execute();
  }
  for (const work of o.hid ?? []) {
    await db.insertInto("request_works").values({ request_id: id, work_id: work }).execute();
  }
}

const state = async (ao3WorkId: number) =>
  await db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();

const LIVE = { status: "live", hidden_cause: null };
const HIDDEN = { status: "hidden", hidden_cause: "removal_request" };

const statusOf = async (id: string) =>
  (await db.selectFrom("requests").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const optOutActive = async (requestId: string) =>
  (
    await db
      .selectFrom("optouts")
      .select("active")
      .where("request_id", "=", requestId)
      .executeTakeFirstOrThrow()
  ).active;

const logRows = (targetIds: string[]) =>
  db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id", "note"])
    .where("target_id", "in", targetIds)
    .orderBy("created_at")
    .execute();

describe("18 moderation", () => {
  it("Related requests are listed together", async () => {
    const email = "mod5-spree@example.test";
    const ip = "mod5-ip-spree";
    const spree = [1, 2, 3, 4, 5].map((n) => `mod5-rel-${n}`);
    for (const id of spree) await addRequest(id, { email, ip });
    // The same email in other letters, and the same IP under another email: both related.
    await addRequest("mod5-rel-email-only", { email: "MOD5-Spree@Example.Test" });
    await addRequest("mod5-rel-ip-only", { ip });
    await addRequest("mod5-rel-unrelated", {});

    const res = await get("/admin/requests/mod5-rel-1", moderator);
    expect(res.status).toBe(200);
    const html = await res.text();
    const link = (id: string) => `href="/admin/requests/${id}"`;
    for (const id of [...spree.slice(1), "mod5-rel-email-only", "mod5-rel-ip-only"]) {
      expect(html, id).toContain(link(id));
    }
    expect(html).not.toContain(link("mod5-rel-unrelated"));
    // The page is not listed as its own relative, and no IP hash is printed.
    expect(html).not.toContain(link("mod5-rel-1"));
    expect(html).not.toContain(ip);
  });

  it("A request with no relatives says so, and only a moderator sees the page", async () => {
    await addRequest("mod5-rel-alone", {});
    const html = await (await get("/admin/requests/mod5-rel-alone", moderator)).text();
    expect(html).toContain("No other requests from the same contact email or IP");
    expect((await get("/admin/requests/mod5-rel-alone", plainUser)).status).toBe(404);
    expect((await get("/admin/requests/mod5-rel-alone")).status).toBe(404);
  });

  it("Bulk restore undoes a mass-hiding spree", async () => {
    const email = "mod5-bulk@example.test";
    const ip = "mod5-ip-bulk";
    const ids = [0, 1, 2, 3, 4].map((n) => `mod5-bulk-${n}`);
    const ao3 = [40300, 40301, 40302, 40303, 40304];
    for (const [n, id] of ids.entries()) {
      const work = await seed(ao3[n]!, "removal_request");
      await addRequest(id, { work, hid: [work], email, ip });
    }
    const other = await seed(40305, "removal_request");
    await addRequest("mod5-bulk-unrelated", { work: other, hid: [other] });

    const res = await post("/admin/requests/mod5-bulk-2/restore-related", moderator);
    expect(res.status).toBe(200);
    for (const n of ao3) expect(await state(n), String(n)).toEqual(LIVE);
    expect(await state(40305)).toEqual(HIDDEN);
    for (const id of ids) expect(await statusOf(id)).toBe("rejected");
    expect(await statusOf("mod5-bulk-unrelated")).toBe("pending");
    // One reject per request, with the moderator; the restores are logged in its note.
    const rows = await logRows(ids);
    expect(rows.map((r) => [r.action, r.target_kind, r.moderator_id])).toEqual(
      ids.map(() => ["reject", "request", moderatorId]),
    );
    expect(rows.map((r) => r.note).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      ao3.map((n) => `Restored works: ${n}`).sort((a, b) => String(a).localeCompare(String(b))),
    );
    expect(await logRows(["mod5-bulk-unrelated"])).toEqual([]);
  });

  it("A second bulk restore changes nothing and logs nothing", async () => {
    const email = "mod5-twice@example.test";
    const work = await seed(40306, "removal_request");
    await addRequest("mod5-twice-0", { work, hid: [work], email });
    await addRequest("mod5-twice-1", { email });
    await post("/admin/requests/mod5-twice-1/restore-related", moderator);
    const first = await logRows(["mod5-twice-0", "mod5-twice-1", work]);
    expect(first.map((r) => r.target_id).sort()).toEqual(["mod5-twice-0", "mod5-twice-1"]);
    expect(await state(40306)).toEqual(LIVE);
    const res = await post("/admin/requests/mod5-twice-1/restore-related", moderator);
    expect(res.status).toBe(200);
    expect(await logRows(["mod5-twice-0", "mod5-twice-1", work])).toEqual(first);
  });

  it("Bulk restore leaves a work a moderator or the reports hid, and an opt-out's works", async () => {
    const email = "mod5-edge@example.test";
    const byModerator = await seed(40307, "moderator");
    const byReports = await seed(40308, "reports");
    const optedOut = await seed(40309, "removal_request");
    await addRequest("mod5-edge-mod", { work: byModerator, hid: [byModerator], email });
    // A request on a work the reports hid, with no link row of its own.
    await addRequest("mod5-edge-reports", { work: byReports, email });
    await addRequest("mod5-edge-optout", { pseud: "mod5-edge-pseud", hid: [optedOut], email });
    await post("/admin/requests/mod5-edge-mod/restore-related", moderator);
    expect(await state(40307)).toEqual({ status: "hidden", hidden_cause: "moderator" });
    expect(await state(40308)).toEqual({ status: "hidden", hidden_cause: "reports" });
    // An opt-out is reversed by its own reject, not by a spree's restore.
    expect(await state(40309)).toEqual(HIDDEN);
    expect(await optOutActive("mod5-edge-optout")).toBe(true);
    expect(await statusOf("mod5-edge-optout")).toBe("pending");
  });

  it("Bulk restore keeps a work another pending request or an active opt-out still covers", async () => {
    const email = "mod5-cover@example.test";
    const pending = await seed(40310, "removal_request");
    const coAuthored = await seed(40311, "removal_request", ["mod5-cover-p", "mod5-cover-q"]);
    await addRequest("mod5-cover-a", { work: pending, hid: [pending], email });
    await addRequest("mod5-cover-b", { work: coAuthored, hid: [coAuthored], email });
    // Elsewhere: a pending request for the first work that hid nothing (#480), and an
    // opt-out for one co-author that names the second (#193).
    await addRequest("mod5-cover-c", { work: pending });
    await addRequest("mod5-cover-q", { pseud: "mod5-cover-q" });
    const res = await post("/admin/requests/mod5-cover-a/restore-related", moderator);
    expect(await state(40310)).toEqual(HIDDEN);
    expect(await state(40311)).toEqual(HIDDEN);
    expect(await res.text()).toContain("2 works stay hidden");
    expect(await statusOf("mod5-cover-c")).toBe("pending");
  });

  it("Only a moderator, from the site itself, can restore in bulk", async () => {
    const work = await seed(40312, "removal_request");
    await addRequest("mod5-auth", { work, hid: [work] });
    for (const cookie of [undefined, plainUser]) {
      expect((await post("/admin/requests/mod5-auth/restore-related", cookie)).status).toBe(404);
    }
    const crossSite = await fetchW("/admin/requests/mod5-auth/restore-related", {
      method: "POST",
      headers: {
        cookie: moderator,
        origin: "https://elsewhere.test",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(crossSite.status).toBe(404);
    expect(await state(40312)).toEqual(HIDDEN);
    expect(await statusOf("mod5-auth")).toBe("pending");
    expect((await post("/admin/requests/mod5-nothing/restore-related", moderator)).status).toBe(
      404,
    );
  });
});

describe("16 removal and opt-out", () => {
  it("Moderator confirms an opt-out", async () => {
    const works = [await seed(40320, "removal_request"), await seed(40321, "removal_request")];
    await addRequest("mod5-confirm", { pseud: "mod5-confirm-pseud", hid: works });
    const page = await (await get("/admin/requests/mod5-confirm", moderator)).text();
    expect(page).toContain("Confirm opt-out");
    const res = await post("/admin/requests/mod5-confirm/approve", moderator);
    expect(res.status).toBe(200);
    expect(await statusOf("mod5-confirm")).toBe("approved");
    expect(await optOutActive("mod5-confirm")).toBe(true);
    expect(await state(40320)).toEqual(HIDDEN);
    expect(await state(40321)).toEqual(HIDDEN);
    expect(await logRows(["mod5-confirm"])).toMatchObject([
      { moderator_id: moderatorId, action: "approve", target_kind: "request" },
    ]);
    // Again: decided already, no second row.
    const again = await post("/admin/requests/mod5-confirm/approve", moderator);
    expect(await again.text()).toContain("decided already");
    expect(await logRows(["mod5-confirm"])).toHaveLength(1);
  });

  it("Confirming an opt-out is for moderators only", async () => {
    await addRequest("mod5-confirm-auth", { pseud: "mod5-confirm-auth-pseud" });
    expect((await post("/admin/requests/mod5-confirm-auth/approve", plainUser)).status).toBe(404);
    expect(await statusOf("mod5-confirm-auth")).toBe("pending");
  });

  it("Mistaken opt-out can be reversed", async () => {
    const mine = [40330, 40331, 40332];
    const works = [];
    for (const n of mine) works.push(await seed(n, "removal_request"));
    const byModerator = await seed(40333, "moderator");
    await seed(40334);
    await addRequest("mod5-rev", {
      pseud: "mod5-rev-pseud",
      hid: works,
      status: "approved",
    });
    const page = await (await get("/admin/requests/mod5-rev", moderator)).text();
    expect(page).toContain("Reverse opt-out");

    const res = await post("/admin/requests/mod5-rev/reject", moderator);
    expect(res.status).toBe(200);
    expect(await optOutActive("mod5-rev")).toBe(false);
    expect(await statusOf("mod5-rev")).toBe("rejected");
    for (const n of mine) expect(await state(n), String(n)).toEqual(LIVE);
    expect(await state(40333)).toEqual({ status: "hidden", hidden_cause: "moderator" });
    expect(await state(40334)).toEqual(LIVE);
    expect(byModerator).toBeTruthy();
    // One reject on the request, with the works in its note; no row per work.
    expect(await logRows(["mod5-rev", ...works])).toMatchObject([
      {
        moderator_id: moderatorId,
        action: "reject",
        target_kind: "request",
        target_id: "mod5-rev",
        note: "Restored works: 40330, 40331, 40332",
      },
    ]);
    // A second reverse changes nothing.
    const again = await post("/admin/requests/mod5-rev/reject", moderator);
    expect(await again.text()).toContain("decided already");
    expect(await logRows(["mod5-rev"])).toHaveLength(1);
  });

  it("Reversing a pending opt-out restores its works too", async () => {
    const work = await seed(40335, "removal_request");
    await addRequest("mod5-rev-pending", { pseud: "mod5-rev-pending-pseud", hid: [work] });
    await post("/admin/requests/mod5-rev-pending/reject", moderator);
    expect(await optOutActive("mod5-rev-pending")).toBe(false);
    expect(await state(40335)).toEqual(LIVE);
  });

  it("Reversing an opt-out keeps a work a pending removal request still covers", async () => {
    const work = await seed(40336, "removal_request");
    await addRequest("mod5-rev-480", { pseud: "mod5-rev-480-pseud", hid: [work] });
    // Asked for the same work, but hid nothing itself (#480).
    await addRequest("mod5-rev-480-other", { work });
    await post("/admin/requests/mod5-rev-480/reject", moderator);
    expect(await optOutActive("mod5-rev-480")).toBe(false);
    expect(await state(40336)).toEqual(HIDDEN);
  });

  it("Reversing an opt-out keeps a co-authored work while another opt-out names a co-author", async () => {
    const work = await seed(40337, "removal_request", ["mod5-co-p", "mod5-co-q"]);
    await addRequest("mod5-co-p", { pseud: "mod5-co-p", hid: [work] });
    await addRequest("mod5-co-q", { pseud: "mod5-co-q" });
    await post("/admin/requests/mod5-co-p/reject", moderator);
    expect(await optOutActive("mod5-co-p")).toBe(false);
    expect(await state(40337)).toEqual(HIDDEN);
    // Q hid nothing of it, so reversing Q does not bring it back: a moderator restores it.
    await post("/admin/requests/mod5-co-q/reject", moderator);
    expect(await optOutActive("mod5-co-q")).toBe(false);
    expect(await state(40337)).toEqual(HIDDEN);
  });

  it("Rejecting a removal request restores only a work its own link row names", async () => {
    const hidByOptOut = await seed(40338, "removal_request", ["mod5-rej-author"]);
    const hidByIt = await seed(40339, "removal_request");
    await addRequest("mod5-rej-optout", { pseud: "mod5-rej-author", hid: [hidByOptOut] });
    // No link row: this request did not hide the work, an opt-out did.
    await addRequest("mod5-rej-nolink", { work: hidByOptOut });
    await addRequest("mod5-rej-linked", { work: hidByIt, hid: [hidByIt] });
    await post("/admin/requests/mod5-rej-nolink/reject", moderator);
    expect(await state(40338)).toEqual(HIDDEN);
    expect(await optOutActive("mod5-rej-optout")).toBe(true);
    await post("/admin/requests/mod5-rej-linked/reject", moderator);
    expect(await state(40339)).toEqual(LIVE);
  });

  it("Only a moderator reverses an opt-out", async () => {
    const work = await seed(40340, "removal_request");
    await addRequest("mod5-rev-auth", { pseud: "mod5-rev-auth-pseud", hid: [work] });
    expect((await post("/admin/requests/mod5-rev-auth/reject", plainUser)).status).toBe(404);
    expect(await optOutActive("mod5-rev-auth")).toBe(true);
    expect(await state(40340)).toEqual(HIDDEN);
  });
});
