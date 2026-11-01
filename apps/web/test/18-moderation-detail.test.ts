import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, emailsTo, fetchW, LOGIN_TOKEN, postLogin } from "./helpers";

// One database serves every test file in the run. This file keeps to AO3 work IDs
// 14100 to 14199 and gives every row an id and a marker starting "mod2-". Text is
// synthetic.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** A copy of 18-moderation.test.ts's `signIn`: A4 (#24) brings the shared one to helpers.ts. */
async function signIn(email: string, role: string | null): Promise<string> {
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const [sent] = await emailsTo(email);
  const token = new URL(sent!.url).searchParams.get("token")!;
  const res = await postLogin({ token, next: "/" }, { url: "/login/confirm" });
  expect(res.status).toBe(303);
  await db
    .updateTable("user")
    .set({ role, terms_accepted_at: new Date() })
    .where("email", "=", email)
    .execute();
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

let moderator: string;
let reporterId: string;

beforeAll(async () => {
  moderator = await signIn("mod2-moderator@example.test", "moderator");
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

const state = (ao3WorkId: number) =>
  db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();

async function seed(ao3WorkId: number, options: Parameters<typeof seedWork>[1] = {}) {
  const seeded = await seedWork(db, { ao3WorkId, title: `mod2-title-${ao3WorkId}`, ...options });
  reporterId = seeded.userId;
  return seeded.workId;
}

const addReport = (id: string, workId: string) =>
  db
    .insertInto("reports")
    .values({
      id,
      work_id: workId,
      reporter_id: reporterId,
      kind: "mod2-kind",
      body: `${id}-body`,
      created_at: "2001-06-01T00:00:00Z",
    })
    .execute();

const addTakedown = (id: string, workId: string) =>
  db
    .insertInto("takedowns")
    .values({
      id,
      work_id: workId,
      requester: `${id}@example.test`,
      basis: `${id}-basis`,
      signature: `${id}-signature`,
      infringing_material: `${id}-material`,
      good_faith: true,
      accuracy_authority: false,
      incomplete: true,
      created_at: "2001-06-01T00:00:00Z",
    })
    .execute();

const addRequest = (id: string, workId: string | null, kind: "remove_work" | "opt_out") =>
  db
    .insertInto("requests")
    .values({
      id,
      kind,
      work_id: workId,
      pseud_norm: workId === null ? `${id}-pseud` : null,
      contact_email: `${id}@example.test`,
      statement: `${id}-statement`,
      ip_hash: "mod2-ip-hash",
      created_at: "2001-06-01T00:00:00Z",
    })
    .execute();

const statusOf = async (table: "reports" | "takedowns" | "requests", id: string) =>
  (await db.selectFrom(table).select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

describe("18 moderation detail pages", () => {
  it("Each item has a detail page with actions", async () => {
    const W = 14100;
    const workId = await seed(W);
    await addReport("mod2-detail-report", workId);
    await addTakedown("mod2-detail-takedown", workId);
    await addRequest("mod2-detail-request", workId, "remove_work");
    await addRequest("mod2-detail-optout", null, "opt_out");
    const hide = `action="/admin/works/${W}/hide"`;
    const restore = `action="/admin/works/${W}/restore"`;
    const reject = (queue: string, id: string) => `action="/admin/${queue}/${id}/reject"`;

    for (const [path, shown, forms, absent] of [
      [
        "/admin/reports/mod2-detail-report",
        ["mod2-detail-report-body", `mod2-title-${W}`, String(W)],
        [hide, restore],
        [],
      ],
      [
        "/admin/takedowns/mod2-detail-takedown",
        [
          "mod2-detail-takedown@example.test",
          "mod2-detail-takedown-basis",
          "mod2-detail-takedown-signature",
          "mod2-detail-takedown-material",
          "Incomplete",
        ],
        [hide, restore, reject("takedowns", "mod2-detail-takedown")],
        [],
      ],
      [
        "/admin/requests/mod2-detail-request",
        ["mod2-detail-request@example.test", "mod2-detail-request-statement", `mod2-title-${W}`],
        [hide, restore, reject("requests", "mod2-detail-request")],
        [],
      ],
      [
        // An opt-out names no work: nothing to hide or restore.
        "/admin/requests/mod2-detail-optout",
        ["mod2-detail-optout-pseud", "mod2-detail-optout@example.test"],
        [reject("requests", "mod2-detail-optout")],
        ["/hide", "/restore"],
      ],
    ] as const) {
      const res = await get(path, moderator);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      const html = await res.text();
      expect(html, path).not.toMatch(/<script/i);
      for (const text of shown) expect(html, path).toContain(text);
      for (const form of forms) expect(html, path).toContain(form);
      for (const text of absent) expect(html, path).not.toContain(text);
      expect(html, path).toContain('method="post"');
    }
  });

  it("A queue row links to its detail page", async () => {
    const workId = await seed(14101);
    await addReport("mod2-link-report", workId);
    await addTakedown("mod2-link-takedown", workId);
    await addRequest("mod2-link-request", workId, "remove_work");
    for (const [queue, id] of [
      ["reports", "mod2-link-report"],
      ["takedowns", "mod2-link-takedown"],
      ["requests", "mod2-link-request"],
    ]) {
      const html = await (await get(`/admin/${queue}`, moderator)).text();
      expect(html, queue).toContain(`<a href="/admin/${queue}/${id}">`);
    }
  });

  it("An unknown item is not found", async () => {
    for (const queue of ["reports", "takedowns", "requests"]) {
      const res = await get(`/admin/${queue}/mod2-no-such-item`, moderator);
      expect(res.status, queue).toBe(404);
    }
  });

  it("Moderator hides a work", async () => {
    const W = 14102;
    const workId = await seed(W);
    await addReport("mod2-hide-report", workId);
    const res = await post(`/admin/works/${W}/hide`, moderator, {
      from: "/admin/reports/mod2-hide-report",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "moderator" });
    const page = await get(`/works/${W}`);
    expect(page.status).toBe(451);
    expect(await page.text()).toContain("Temporarily hidden by a moderator");
  });

  it("Moderator hides a work after a DMCA notice", async () => {
    const W = 14103;
    const workId = await seed(W);
    await addTakedown("mod2-dmca-takedown", workId);
    const res = await post(`/admin/works/${W}/hide`, moderator, {
      from: "/admin/takedowns/mod2-dmca-takedown",
    });
    expect(res.status).toBe(200);
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "moderator" });
    const page = await get(`/works/${W}`);
    expect(page.status).toBe(451);
    expect(await page.text()).toContain("Temporarily hidden by a moderator");
    // A hide is not a decision on the notice: it stays pending for XR2.
    expect(await statusOf("takedowns", "mod2-dmca-takedown")).toBe("pending");
  });

  it("A moderator's hide takes over the cause of a hidden work", async () => {
    const W = 14104;
    await seed(W, { status: "hidden", hiddenCause: "reports" });
    await post(`/admin/works/${W}/hide`, moderator);
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "moderator" });
  });

  it("Moderator restores a hidden work", async () => {
    const W = 14105;
    const workId = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addRequest("mod2-restore-request", workId, "remove_work");
    const res = await post("/admin/requests/mod2-restore-request/reject", moderator);
    expect(res.status).toBe(200);
    expect(await statusOf("requests", "mod2-restore-request")).toBe("rejected");
    expect(await state(W)).toEqual({ status: "live", hidden_cause: null });
    expect((await get(`/works/${W}`)).status).toBe(200);
  });

  it("Rejecting a request does not restore a work a moderator hid", async () => {
    const W = 14106;
    const workId = await seed(W, { status: "hidden", hiddenCause: "moderator" });
    await addRequest("mod2-keep-request", workId, "remove_work");
    await post("/admin/requests/mod2-keep-request/reject", moderator);
    expect(await statusOf("requests", "mod2-keep-request")).toBe("rejected");
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "moderator" });
  });

  it("Rejecting one of two removal requests keeps the work hidden until both are decided", async () => {
    const W = 14113;
    const workId = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addRequest("mod2-two-request-a", workId, "remove_work");
    await addRequest("mod2-two-request-b", workId, "remove_work");
    await post("/admin/requests/mod2-two-request-a/reject", moderator);
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "removal_request" });
    await post("/admin/requests/mod2-two-request-b/reject", moderator);
    expect(await state(W)).toEqual({ status: "live", hidden_cause: null });
  });

  it("An id with odd characters is not found", async () => {
    for (const path of ["/admin/reports/%00", "/admin/requests/a%20b", "/admin/takedowns/%2e%2e"]) {
      expect((await get(path, moderator)).status, path).toBe(404);
    }
    expect((await post("/admin/requests/%00/reject", moderator)).status).toBe(404);
  });

  it("Rejecting an opt-out or a takedown only sets its status", async () => {
    const workId = await seed(14107);
    await addRequest("mod2-reject-optout", null, "opt_out");
    await addTakedown("mod2-reject-takedown", workId);
    expect((await post("/admin/requests/mod2-reject-optout/reject", moderator)).status).toBe(200);
    expect((await post("/admin/takedowns/mod2-reject-takedown/reject", moderator)).status).toBe(
      200,
    );
    expect(await statusOf("requests", "mod2-reject-optout")).toBe("rejected");
    expect(await statusOf("takedowns", "mod2-reject-takedown")).toBe("rejected");
    expect((await state(14107)).status).toBe("live");
  });

  it("Restore makes a moderator-hidden work live and closes its open reports", async () => {
    const W = 14108;
    const workId = await seed(W, { status: "hidden", hiddenCause: "moderator" });
    await addReport("mod2-restore-report", workId);
    const res = await post(`/admin/works/${W}/restore`, moderator);
    expect(res.status).toBe(200);
    expect(await state(W)).toEqual({ status: "live", hidden_cause: null });
    expect(await statusOf("reports", "mod2-restore-report")).toBe("closed");
  });

  it("Restoring a removed work changes nothing", async () => {
    const W = 14109;
    await seed(W, { status: "removed" });
    const res = await post(`/admin/works/${W}/restore`, moderator);
    expect(res.status).toBe(200);
    expect((await state(W)).status).toBe("removed");
  });

  it("A work that does not exist is not found", async () => {
    for (const id of ["14199", "nope", "0", "99999999999"]) {
      expect((await post(`/admin/works/${id}/hide`, moderator)).status, id).toBe(404);
    }
  });

  it("Non-moderators and signed-out visitors get 404 and change nothing", async () => {
    const W = 14110;
    const workId = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addRequest("mod2-refused-request", workId, "remove_work");
    await addTakedown("mod2-refused-takedown", workId);
    await seed(14111);
    const plain = await signIn("mod2-plain-user@example.test", "user");
    const notFound = await (await get("/mod2-no-such-page")).text();
    for (const cookie of [undefined, plain]) {
      for (const [method, path] of [
        ["POST", `/admin/works/${W}/restore`],
        ["POST", "/admin/works/14111/hide"],
        ["POST", "/admin/requests/mod2-refused-request/reject"],
        ["POST", "/admin/takedowns/mod2-refused-takedown/reject"],
        ["GET", "/admin/requests/mod2-refused-request"],
        ["GET", "/admin/takedowns/mod2-refused-takedown"],
      ] as const) {
        const res = method === "GET" ? await get(path, cookie) : await post(path, cookie);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toBe(notFound);
      }
    }
    expect(await state(W)).toEqual({ status: "hidden", hidden_cause: "removal_request" });
    expect((await state(14111)).status).toBe("live");
    expect(await statusOf("requests", "mod2-refused-request")).toBe("pending");
    expect(await statusOf("takedowns", "mod2-refused-takedown")).toBe("pending");
  });

  it("A post from another origin gets the same 404 and changes nothing", async () => {
    const W = 14112;
    await seed(W);
    const notFound = await (await get("/mod2-no-such-page")).text();
    const crossSite: Record<string, string>[] = [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      // No origin and no fetch metadata at all: nothing says it came from the site.
      {},
    ];
    for (const headers of crossSite) {
      const res = await post(`/admin/works/${W}/hide`, moderator, {}, headers);
      expect(res.status, JSON.stringify(headers)).toBe(404);
      expect(await res.text()).toBe(notFound);
    }
    expect((await state(W)).status).toBe("live");
  });
});

describe("18 moderation action log", () => {
  const moderatorId = async () =>
    (
      await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", "mod2-moderator@example.test")
        .executeTakeFirstOrThrow()
    ).id;

  const logFor = (targetId: string) =>
    db.selectFrom("moderation_actions").selectAll().where("target_id", "=", targetId).execute();

  it("Hide and restore each write one row with the signed-in moderator", async () => {
    const W = 14120;
    const workId = await seed(W);
    await post(`/admin/works/${W}/hide`, moderator);
    expect(await logFor(workId)).toMatchObject([
      { moderator_id: await moderatorId(), action: "hide", target_kind: "work", note: null },
    ]);
    await post(`/admin/works/${W}/restore`, moderator);
    const rows = await logFor(workId);
    expect(rows.map((r) => r.action).sort()).toEqual(["hide", "restore"]);
    expect(new Set(rows.map((r) => r.moderator_id))).toEqual(new Set([await moderatorId()]));
  });

  it("A request reject writes one row on the request, and none for the work it restored", async () => {
    const W = 14121;
    const workId = await seed(W, { status: "hidden", hiddenCause: "removal_request" });
    await addRequest("mod2-log-request", workId, "remove_work");
    await post("/admin/requests/mod2-log-request/reject", moderator);
    expect(await state(W)).toEqual({ status: "live", hidden_cause: null });
    expect(await logFor("mod2-log-request")).toMatchObject([
      { moderator_id: await moderatorId(), action: "reject", target_kind: "request" },
    ]);
    expect(await logFor(workId)).toEqual([]);
  });

  it("A takedown reject writes one row with the moderator", async () => {
    const workId = await seed(14122);
    await addTakedown("mod2-log-takedown", workId);
    await post("/admin/takedowns/mod2-log-takedown/reject", moderator);
    expect(await logFor("mod2-log-takedown")).toMatchObject([
      { moderator_id: await moderatorId(), action: "reject", target_kind: "takedown" },
    ]);
  });

  it("An action that changes nothing writes no row", async () => {
    const removed = await seed(14123, { status: "removed" });
    await post("/admin/works/14123/hide", moderator);
    await post("/admin/works/14123/restore", moderator);
    expect(await logFor(removed)).toEqual([]);
    const workId = await seed(14124);
    await addRequest("mod2-log-decided", workId, "remove_work");
    await post("/admin/requests/mod2-log-decided/reject", moderator);
    await post("/admin/requests/mod2-log-decided/reject", moderator);
    expect(await logFor("mod2-log-decided")).toHaveLength(1);
  });

  it("A refused post writes no row", async () => {
    const workId = await seed(14125);
    await post("/admin/works/14125/hide", undefined);
    await post("/admin/works/14125/hide", moderator, {}, { origin: "https://evil.example" });
    expect(await logFor(workId)).toEqual([]);
  });
});
