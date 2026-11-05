import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, fetchW, signIn } from "./helpers";

// One database serves every test file in the run. This file keeps to AO3 work IDs 60800 to
// 60849 and gives every row an id and a marker starting "dismiss-". Text is synthetic.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const signInAs = async (email: string, role: string) => {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role }).where("email", "=", email).execute();
  return cookie;
};

let moderator: string;
let moderatorId: string;

beforeAll(async () => {
  moderator = await signInAs("dismiss-moderator@example.test", "moderator");
  const row = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", "dismiss-moderator@example.test")
    .executeTakeFirstOrThrow();
  moderatorId = row.id;
});

const get = (path: string, cookie?: string) =>
  fetchW(path, { headers: cookie === undefined ? {} : { cookie } });

/** A form post as the site's own page makes it, unless `headers` say otherwise. */
const post = (
  path: string,
  cookie?: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = { origin: BASE, "sec-fetch-site": "same-origin" },
) => {
  const sent = new Headers(headers);
  sent.set("content-type", "application/x-www-form-urlencoded");
  if (cookie !== undefined) sent.set("cookie", cookie);
  return fetchW(path, {
    method: "POST",
    headers: sent,
    body: new URLSearchParams(fields).toString(),
  });
};

const seed = (ao3WorkId: number, options: Parameters<typeof seedWork>[1] = {}) =>
  seedWork(db, { ao3WorkId, title: `dismiss-title-${ao3WorkId}`, ...options });

/** An open report, old enough to sort at the head of the queue whatever else is in it. */
const addReport = (id: string, workId: string, reporterId: string, kind = "dismiss-kind") =>
  db
    .insertInto("reports")
    .values({
      id,
      work_id: workId,
      reporter_id: reporterId,
      kind,
      body: `${id}-body`,
      created_at: "2000-06-01T00:00:00Z",
    })
    .execute();

const addRequest = async (
  id: string,
  workId: string | null,
  options: { pseud?: string; status?: string; hid?: string[] } = {},
) => {
  await db
    .insertInto("requests")
    .values({
      id,
      kind: options.pseud === undefined ? "remove_work" : "opt_out",
      work_id: workId,
      pseud_norm: options.pseud ?? null,
      contact_email: `${id}@example.test`,
      statement: `${id}-statement`,
      ip_hash: `${id}-ip`,
      status: options.status ?? "pending",
      confirmed_at: "2001-06-01T00:05:00Z",
    })
    .execute();
  for (const hid of options.hid ?? []) {
    await db.insertInto("request_works").values({ request_id: id, work_id: hid }).execute();
  }
};

const reportStatus = async (id: string) =>
  (await db.selectFrom("reports").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const state = (ao3WorkId: number) =>
  db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();

const logFor = (targetId: string) =>
  db.selectFrom("moderation_actions").selectAll().where("target_id", "=", targetId).execute();

const queueHtml = async () => (await get("/admin/reports", moderator)).text();

const LIVE = { status: "live", hidden_cause: null };

describe("18-moderation", () => {
  it("A moderator dismisses a report", async () => {
    const W = 60800;
    const { workId, userId } = await seed(W);
    await addReport("dismiss-one", workId, userId);
    expect(await queueHtml()).toContain('href="/admin/reports/dismiss-one"');
    const page = await (await get("/admin/reports/dismiss-one", moderator)).text();
    expect(page).toContain('action="/admin/reports/dismiss-one/dismiss"');
    expect(page).toContain(">Dismiss report</button>");

    const res = await post("/admin/reports/dismiss-one/dismiss", moderator);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const done = await res.text();
    expect(done).toContain("Report dismissed.");
    expect(done).toContain('href="/admin/reports/dismiss-one"');
    expect(await reportStatus("dismiss-one")).toBe("closed");
    expect(await queueHtml()).not.toContain('href="/admin/reports/dismiss-one"');
    expect(await logFor("dismiss-one")).toMatchObject([
      { moderator_id: moderatorId, action: "dismiss", target_kind: "report" },
    ]);
    expect(await state(W)).toEqual(LIVE);
    expect((await get(`/works/${W}`)).status).toBe(200);
    // Closed, its page stays, without the form.
    const after = await (await get("/admin/reports/dismiss-one", moderator)).text();
    expect(after).toContain("<dt>Status</dt><dd>closed</dd>");
    expect(after).not.toContain("dismiss-one/dismiss");
  });

  it("Dismissing a report leaves a hidden work hidden", async () => {
    const W = 60801;
    const { workId, userId } = await seed(W, { status: "hidden", hiddenCause: "reports" });
    await addReport("dismiss-hidden", workId, userId);
    const res = await post("/admin/reports/dismiss-hidden/dismiss", moderator);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("it stays hidden until you restore it");
    expect(await reportStatus("dismiss-hidden")).toBe("closed");
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "reports" });
    expect((await get(`/works/${W}`)).status).toBe(451);
  });

  it("Dismissing a closed report changes nothing", async () => {
    const { workId, userId } = await seed(60802);
    await addReport("dismiss-twice", workId, userId);
    await post("/admin/reports/dismiss-twice/dismiss", moderator);
    const again = await post("/admin/reports/dismiss-twice/dismiss", moderator);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Nothing changed");
    expect(await logFor("dismiss-twice")).toHaveLength(1);
  });

  it("A wrong-version report can't be dismissed", async () => {
    const { workId, userId } = await seed(60803);
    await addReport("dismiss-wrong", workId, userId, "wrong_version");
    for (const path of [
      "/admin/reports/dismiss-wrong/dismiss",
      "/admin/reports/dismiss-no-such/dismiss",
      "/admin/reports/%00/dismiss",
    ]) {
      expect((await post(path, moderator)).status, path).toBe(404);
    }
    expect(await reportStatus("dismiss-wrong")).toBe("open");
    expect(await logFor("dismiss-wrong")).toEqual([]);
  });

  it("Only a moderator can dismiss a report", async () => {
    const { workId, userId } = await seed(60804);
    await addReport("dismiss-refused", workId, userId);
    const plain = await signInAs("dismiss-plain@example.test", "user");
    const path = "/admin/reports/dismiss-refused/dismiss";
    for (const cookie of [undefined, plain]) {
      // The same visitor's own not-found page: the header shows who asks.
      const notFound = await (await get("/dismiss-no-such-page", cookie)).text();
      const res = await post(path, cookie);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(notFound);
    }
    const notFound = await (await get("/dismiss-no-such-page", moderator)).text();
    const crossSite: Record<string, string>[] = [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      {},
    ];
    for (const headers of crossSite) {
      const res = await post(path, moderator, {}, headers);
      expect(res.status, JSON.stringify(headers)).toBe(404);
      expect(await res.text()).toBe(notFound);
    }
    expect(await reportStatus("dismiss-refused")).toBe("open");
    expect(await logFor("dismiss-refused")).toEqual([]);
  });

  it("A dismissed report stops counting toward the automatic hide", async () => {
    const W = 60805;
    await seed(W);
    const report = (cookie: string) => post(`/works/${W}/report`, cookie, { reason: "other" });
    const signInReporter = (n: number) =>
      signIn(`dismiss-count-${n}@example.test`, { acceptTerms: true });
    const [u, u2, u3, u4] = [
      await signInReporter(1),
      await signInReporter(2),
      await signInReporter(3),
      await signInReporter(4),
    ];
    // The first report in, so it is the one found, and dismissed, before the others.
    await report(u3);
    const { id } = await db
      .selectFrom("reports")
      .innerJoin("works", "works.id", "reports.work_id")
      .select("reports.id")
      .where("works.ao3_work_id", "=", W)
      .executeTakeFirstOrThrow();
    expect((await post(`/admin/reports/${id}/dismiss`, moderator)).status).toBe(200);
    await report(u);
    await report(u2);
    await report(u2);
    expect(await state(W)).toEqual(LIVE);
    await report(u4);
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "reports" });
  });

  it("Rejecting a removal request leaves reports open", async () => {
    const W = 60806;
    const { workId, userId } = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addReport("dismiss-kept-reject", workId, userId);
    await addReport("dismiss-kept-wrong", workId, userId, "wrong_version");
    await addRequest("dismiss-request", workId, { hid: [workId] });

    expect((await post("/admin/requests/dismiss-request/reject", moderator)).status).toBe(200);

    expect(await state(W)).toEqual(LIVE);
    expect(await reportStatus("dismiss-kept-reject")).toBe("open");
    expect(await reportStatus("dismiss-kept-wrong")).toBe("open");
    expect(await queueHtml()).toContain('href="/admin/reports/dismiss-kept-reject"');
  });

  it("Reversing an opt-out leaves reports open", async () => {
    const W = 60807;
    const { workId, userId } = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addReport("dismiss-kept-optout", workId, userId);
    await addRequest("dismiss-optout", null, {
      pseud: "dismiss-optout-pseud",
      status: "approved",
      hid: [workId],
    });
    await db
      .insertInto("optouts")
      .values({ pseud_norm: "dismiss-optout-pseud", request_id: "dismiss-optout", active: true })
      .execute();

    expect((await post("/admin/requests/dismiss-optout/reject", moderator)).status).toBe(200);

    expect(await state(W)).toEqual(LIVE);
    expect(await reportStatus("dismiss-kept-optout")).toBe("open");
    expect(await queueHtml()).toContain('href="/admin/reports/dismiss-kept-optout"');
  });

  it("A bulk restore leaves reports open", async () => {
    const W = 60808;
    const { workId, userId } = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addReport("dismiss-kept-bulk", workId, userId);
    await addRequest("dismiss-bulk", workId, { hid: [workId] });

    expect((await post("/admin/requests/dismiss-bulk/restore-related", moderator)).status).toBe(
      200,
    );

    expect(await state(W)).toEqual(LIVE);
    expect(await reportStatus("dismiss-kept-bulk")).toBe("open");
    expect(await queueHtml()).toContain('href="/admin/reports/dismiss-kept-bulk"');
  });

  it("A moderator's restore closes reports", async () => {
    const W = 60809;
    const { workId, userId } = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addReport("dismiss-closed-restore", workId, userId);
    expect((await post(`/admin/works/${W}/restore`, moderator)).status).toBe(200);
    expect(await state(W)).toEqual(LIVE);
    expect(await reportStatus("dismiss-closed-restore")).toBe("closed");
  });
});
