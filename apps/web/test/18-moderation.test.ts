import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth";
import { emailsTo, fetchW, LOGIN_TOKEN, postLogin } from "./helpers";

// One database serves every test file in the run, and each queue lists every open
// item in it. So this file keeps to AO3 work IDs 14000 to 14099, gives every row a
// marker starting "mod1-", seeds its rows in 2001 so they sort ahead of anyone
// else's, and asserts only the relative order of its own markers. Text is synthetic.
const WORK = 14000;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/**
 * Signs `email` in through the Worker and gives the account `role`, with the terms
 * accepted. Returns the `name=value` of its session cookie. A copy of
 * session.test.ts's: A4 (#24) brings the shared one to helpers.ts.
 */
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

// ARCHITECTURE, Hosts: on every response.
const HSTS = "max-age=31536000; includeSubDomains";

const QUEUES = ["/admin/reports", "/admin/takedowns", "/admin/requests", "/admin/works"];

let moderator: string;
let workId: string;
let reporterId: string;

beforeAll(async () => {
  moderator = await signIn("mod1-moderator@example.test", "moderator");
  const seeded = await seedWork(db, {
    ao3WorkId: WORK,
    title: "mod1-work-title",
    tags: [{ type: "fandom", name: "mod1-Fandom" }],
  });
  workId = seeded.workId;
  reporterId = seeded.userId;
  await db
    .insertInto("reports")
    .values({
      work_id: workId,
      reporter_id: reporterId,
      kind: "mod1-reason",
      body: "mod1-report-seen",
      created_at: "2001-06-01T00:00:00Z",
    })
    .execute();
  await db
    .insertInto("takedowns")
    .values({
      work_id: workId,
      requester: "mod1-takedown-seen@example.test",
      basis: "mod1-basis-seen",
      created_at: "2001-06-01T00:00:00Z",
    })
    .execute();
  await db
    .insertInto("requests")
    .values({
      kind: "remove_work",
      work_id: workId,
      contact_email: "mod1-request-seen@example.test",
      statement: "mod1-statement-seen",
      ip_hash: "mod1-ip-hash",
      created_at: "2001-06-01T00:00:00Z",
    })
    .execute();
});

/** GETs `path` as the account whose cookie is `cookie`, or signed out. */
const get = (path: string, cookie?: string, init: RequestInit = {}) =>
  fetchW(path, { ...init, headers: cookie === undefined ? {} : { cookie } });

describe("18 moderation", () => {
  it("Moderator sees four queues", async () => {
    const pages = new Map<string, string>();
    for (const path of QUEUES) {
      const res = await get(path, moderator);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("strict-transport-security"), path).toBe(HSTS);
      const html = await res.text();
      expect(html, path).toMatch(/<table[\s>]/);
      expect(html, path).not.toMatch(/<script/i);
      pages.set(path, html);
    }
    // Each seeded item's text is in its own queue's table.
    for (const [path, texts] of [
      ["/admin/reports", ["mod1-report-seen", `mod1-work-title (${WORK})`]],
      ["/admin/takedowns", ["mod1-takedown-seen@example.test", "mod1-basis-seen"]],
      ["/admin/requests", ["mod1-request-seen@example.test", "mod1-statement-seen"]],
    ] as const) {
      const html = pages.get(path) ?? "";
      for (const text of texts) expect(html, path).toContain(text);
    }
  });

  it("Queues are oldest first", async () => {
    // Inserted newest first, so neither insertion order nor id order is the answer.
    const created = ["2001-03-01T00:00:00Z", "2001-01-01T00:00:00Z", "2001-02-01T00:00:00Z"];
    const marker = (queue: string, date: string) => `mod1-${queue}-${date.slice(5, 7)}-month`;
    for (const date of created) {
      await db
        .insertInto("reports")
        .values({
          work_id: workId,
          reporter_id: reporterId,
          kind: "mod1-reason",
          body: marker("report", date),
          created_at: date,
        })
        .execute();
      await db
        .insertInto("takedowns")
        .values({
          work_id: workId,
          requester: marker("takedown", date),
          basis: "mod1-basis",
          created_at: date,
        })
        .execute();
      await db
        .insertInto("requests")
        .values({
          kind: "remove_work",
          work_id: workId,
          contact_email: "mod1-order@example.test",
          statement: marker("request", date),
          ip_hash: "mod1-ip-hash",
          created_at: date,
        })
        .execute();
    }
    for (const [path, queue] of [
      ["/admin/reports", "report"],
      ["/admin/takedowns", "takedown"],
      ["/admin/requests", "request"],
    ] as const) {
      const html = await (await get(path, moderator)).text();
      const positions = ["01", "02", "03"].map((month) =>
        html.indexOf(`mod1-${queue}-${month}-month`),
      );
      expect(
        positions.every((at) => at >= 0),
        path,
      ).toBe(true);
      expect(positions, path).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("Requests queue covers removals and opt-outs", async () => {
    await db
      .insertInto("requests")
      .values([
        {
          kind: "remove_work",
          work_id: workId,
          contact_email: "mod1-removal@example.test",
          statement: "mod1-removal-statement",
          ip_hash: "mod1-ip-hash",
          created_at: "2001-07-01T00:00:00Z",
        },
        {
          kind: "opt_out",
          pseud_norm: "mod1-opted-out-pseud",
          contact_email: "mod1-opt-out@example.test",
          statement: "mod1-opt-out-statement",
          ip_hash: "mod1-ip-hash",
          created_at: "2001-07-02T00:00:00Z",
        },
      ])
      .execute();
    const html = await (await get("/admin/requests", moderator)).text();
    // Each kind in its own row: the removal with its work, the opt-out with its pseud.
    expect(rowWith(html, "mod1-removal-statement")).toEqual([
      "2001-07-01T00:00:00.000Z",
      "remove_work",
      `mod1-work-title (${WORK})`,
      "mod1-removal@example.test",
      "mod1-removal-statement",
    ]);
    expect(rowWith(html, "mod1-opt-out-statement")).toEqual([
      "2001-07-02T00:00:00.000Z",
      "opt_out",
      "mod1-opted-out-pseud",
      "mod1-opt-out@example.test",
      "mod1-opt-out-statement",
    ]);
  });

  it("Items created at the same time are listed in id order", async () => {
    // The second key of "oldest first", so the order holds from one load to the next.
    const at = "2001-09-01T00:00:00Z";
    await db
      .insertInto("requests")
      .values(
        ["mod1-tie-b", "mod1-tie-a"].map((id) => ({
          id,
          kind: "remove_work" as const,
          work_id: workId,
          contact_email: "mod1-tie@example.test",
          statement: `${id}-statement`,
          ip_hash: "mod1-ip-hash",
          created_at: at,
        })),
      )
      .execute();
    const html = await (await get("/admin/requests", moderator)).text();
    const a = html.indexOf("mod1-tie-a-statement");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(html.indexOf("mod1-tie-b-statement"));
  });

  it("Non-moderator gets 404", async () => {
    const notFound = await notFoundBody();
    // Only exactly "moderator" or "admin" lets an account in.
    for (const [email, role] of [
      ["mod1-no-role@example.test", null],
      ["mod1-user-role@example.test", "user"],
      ["mod1-capital-role@example.test", "Moderator"],
      ["mod1-padded-role@example.test", "moderator "],
    ] as const) {
      const cookie = await signIn(email, role);
      for (const [path, method] of ADMIN_REQUESTS) {
        await expectRefused(
          await get(path, cookie, { method }),
          notFound,
          `${role} ${method} ${path}`,
        );
      }
    }
  });

  it("An admin sees the queues too", async () => {
    const admin = await signIn("mod1-admin@example.test", "admin");
    for (const path of [...QUEUES, "/admin"]) {
      expect((await get(path, admin)).status, path).toBe(200);
    }
  });

  it("A moderator demoted is refused at once", async () => {
    const email = "mod1-demoted@example.test";
    const cookie = await signIn(email, "moderator");
    expect((await get("/admin/reports", cookie)).status).toBe(200);
    await db.updateTable("user").set({ role: "user" }).where("email", "=", email).execute();
    await expectRefused(await get("/admin/reports", cookie), await notFoundBody(), "demoted");
  });

  it("The area's own page links to the four queues", async () => {
    const res = await get("/admin", moderator);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    for (const path of QUEUES) expect(html).toContain(`href="${path}"`);
  });

  it("A wrong-version report waits in Works to check, not in Reports", async () => {
    // ARCHITECTURE, Reports: "This version is wrong" only queues the work in Works to check.
    await db
      .insertInto("reports")
      .values([
        {
          work_id: workId,
          reporter_id: reporterId,
          kind: "wrong_version",
          body: "mod1-wrong-version-details",
          created_at: "2001-10-01T00:00:00Z",
        },
        {
          work_id: workId,
          reporter_id: reporterId,
          kind: "mod1-no-details",
          body: null,
          created_at: "2001-10-02T00:00:00Z",
        },
      ])
      .execute();
    const html = await (await get("/admin/reports", moderator)).text();
    expect(html).not.toContain("mod1-wrong-version-details");
    // A report without details is listed with an empty cell.
    expect(rowWith(html, "mod1-no-details")).toEqual([
      "2001-10-02T00:00:00.000Z",
      `mod1-work-title (${WORK})`,
      "mod1-no-details",
      "",
    ]);
  });

  it("Works to check is an empty table for now", async () => {
    const html = await (await get("/admin/works", moderator)).text();
    expect(html).toMatch(/<th scope="col">/);
    expect(html).toContain("This queue is not built yet.");
    expect(html).not.toContain("Nothing waiting.");
  });

  it("Stored text is escaped", async () => {
    await db
      .insertInto("requests")
      .values({
        kind: "opt_out",
        pseud_norm: "mod1-<b>pseud</b>",
        contact_email: `mod1-"><img src=x onerror=alert(1)>@example.test`,
        statement: "mod1-<script>alert(1)</script>",
        ip_hash: "mod1-ip-hash",
        created_at: "2001-08-01T00:00:00Z",
      })
      .execute();
    const res = await get("/admin/requests", moderator);
    const html = await res.text();
    expect(html).not.toMatch(/<script|<img|<b>/i);
    expect(html).toContain("mod1-&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("mod1-&lt;b&gt;pseud&lt;/b&gt;");
    expect(html).toContain("mod1-&quot;&gt;&lt;img src=x onerror=alert(1)&gt;@example.test");
    // The admin pages carry the strict policy, as every page does.
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
  });

  it("A long queue shows its oldest 200", async () => {
    // Dated after every other row this file seeds, so they stay among the oldest shown.
    await db
      .insertInto("takedowns")
      .values(
        Array.from({ length: 201 }, (_, i) => ({
          work_id: workId,
          requester: `mod1-many-${String(i).padStart(3, "0")}-requester`,
          basis: "mod1-basis",
          created_at: new Date(Date.UTC(2999, 0, 1) + i * 60_000).toISOString(),
        })),
      )
      .execute();
    const html = await (await get("/admin/takedowns", moderator)).text();
    expect(html).toContain("Showing the oldest 200.");
    expect(html.match(/<tr><td>/g)).toHaveLength(200);
    expect(html).toContain("mod1-takedown-seen@example.test");
    expect(html).not.toContain("mod1-many-200-requester");
  });

  it("Signed-out visitor gets 404", async () => {
    const notFound = await notFoundBody();
    for (const cookie of [undefined, `${SESSION_COOKIE}=forged.value`]) {
      for (const [path, method] of ADMIN_REQUESTS) {
        await expectRefused(await get(path, cookie, { method }), notFound, `${method} ${path}`);
      }
    }
  });
});

// Every queue, the area's own page with and without its slash, an unknown page, and
// a method no route has.
const ADMIN_REQUESTS = [
  ...[...QUEUES, "/admin", "/admin/", "/admin/nope"].map((path) => [path, "GET"] as const),
  ["/admin/reports", "POST"] as const,
];

/** The cells of the one table row that has `marker`, as the HTML spells them. */
function rowWith(html: string, marker: string): string[] {
  const rows = html.match(/<tr><td>.*?<\/tr>/g) ?? [];
  const [row, ...others] = rows.filter((r) => r.includes(marker));
  expect(others, marker).toEqual([]);
  return [...(row ?? "").matchAll(/<td>(.*?)<\/td>/g)].map((m) =>
    (m[1] ?? "").replace(/^<a href="[^"]*">(.*)<\/a>$/, "$1"),
  );
}

/** The page any unknown URL gets. */
async function notFoundBody() {
  const res = await get("/mod1-no-such-page");
  expect(res.status).toBe(404);
  // As every refusal is: a header only /admin sent would point at it.
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.text();
}

/**
 * The refusal: the not-found page, the same for everyone, never a redirect to
 * sign in, and kept out of caches like every /admin response.
 */
async function expectRefused(res: Response, notFound: string, what: string) {
  expect(res.status, what).toBe(404);
  expect(res.headers.get("location"), what).toBeNull();
  expect(res.headers.get("cache-control"), what).toBe("no-store");
  expect(res.headers.get("strict-transport-security"), what).toBe(HSTS);
  expect(await res.text(), what).toBe(notFound);
}
