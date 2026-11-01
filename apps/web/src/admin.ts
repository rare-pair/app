// The moderation area under /admin (FRONTEND-DISCOVERY, Moderation queues): the gate
// every /admin URL goes through, and the four queues, read only. Actions and detail
// pages come with later tickets (MOD2 on).

import { createDb, type Database } from "@archive/db";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Kysely } from "kysely";
import {
  adminHomePage,
  QUEUE_LIMIT,
  queuePage,
  REPORT_COLUMNS,
  REQUEST_COLUMNS,
  TAKEDOWN_COLUMNS,
  WORK_COLUMNS,
  type Row,
} from "./admin-pages";
import type { Bindings } from "./env";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";

/** The roles with every moderator power (ARCHITECTURE, Data model): an admin has them too. */
export type ModeratorRole = "moderator" | "admin";

/** Set by `adminGate` for every /admin handler: the moderator's role, and the request's database. */
export type AdminVariables = { role: ModeratorRole; db: Kysely<Database> };

type AdminEnv = {
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables & AdminVariables;
};

/** Exactly a role with moderator powers: not null, not "user", no other spelling. */
export const isModerator = (role: string | null | undefined): role is ModeratorRole =>
  role === "moderator" || role === "admin";

type AdminContext = Context<AdminEnv>;

/**
 * Lets a moderator or an admin through to /admin, with their role in `c.var.role`
 * and the database it was read from in `c.var.db`, and answers anyone else, signed
 * out included, with the app's not-found answer: the same status and body for every
 * refusal, never a redirect to sign in, so /admin looks like any URL that doesn't
 * exist (ARCHITECTURE, Decisions so far). Runs after `sessionMiddleware`. The role
 * is read from the database on every request, so a demotion takes effect at once.
 * Every answer it lets through or gives, the refusal included, is `no-store`: the
 * queues hold contact emails and statements. One exception: when the session lookup
 * or the role read fails, `app.onError` answers its 500 instead, with no data in it.
 */
export const adminGate: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const userId = c.var.session?.user.id;
  if (userId === undefined) return refuse(c);
  // One connection serves the role read and the handler's queries. The session
  // lookup before it has its own, until sessions share one (#241).
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const user = await db
      .selectFrom("user")
      .select("role")
      .where("id", "=", userId)
      .executeTakeFirst();
    const role = user?.role ?? null;
    if (!isModerator(role)) return await refuse(c);
    c.set("role", role);
    c.set("db", db);
    await next();
    // After the handler: its own Response doesn't keep headers set before it.
    c.header("Cache-Control", "no-store");
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
};

/** The answer any unknown URL gets from `app.notFound`, which is `no-store` too. */
const refuse = (c: AdminContext) => c.notFound();

const iso = (date: Date) => date.toISOString();

/** "Title (AO3 ID)", for a queue's work column. */
const workCell = (title: string, ao3WorkId: number) => `${title} (${ao3WorkId})`;

/** `GET /admin`: links to the four queues. */
export const showAdminHome = (c: AdminContext) => c.html(adminHomePage());

/** `GET /admin/reports`: open reports. */
export async function showReports(c: AdminContext) {
  const rows = await c.var.db
    .selectFrom("reports")
    .innerJoin("works", "works.id", "reports.work_id")
    .select([
      "reports.created_at",
      "reports.kind",
      "reports.body",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("reports.status", "=", "open")
    // "This version is wrong" only queues the work in Works to check (ARCHITECTURE, Reports).
    .where("reports.kind", "<>", "wrong_version")
    .orderBy("reports.created_at")
    .orderBy("reports.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  const cells = rows.map((r): Row => [
    iso(r.created_at),
    workCell(r.title, r.ao3_work_id),
    r.kind,
    r.body ?? "",
  ]);
  return c.html(queuePage("Reports", REPORT_COLUMNS, cells));
}

/** Which of the notice's two statements were made, for the queue. */
const statements = (r: { good_faith: boolean; accuracy_authority: boolean }) =>
  [r.good_faith ? "good faith" : "", r.accuracy_authority ? "accuracy" : ""]
    .filter((s) => s !== "")
    .join(", ");

/** `GET /admin/takedowns`: pending DMCA notices, an incomplete one marked. */
export async function showTakedowns(c: AdminContext) {
  const rows = await c.var.db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .select([
      "takedowns.created_at",
      "takedowns.requester",
      "takedowns.basis",
      "takedowns.infringing_material",
      "takedowns.signature",
      "takedowns.good_faith",
      "takedowns.accuracy_authority",
      "takedowns.incomplete",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("takedowns.status", "=", "pending")
    .orderBy("takedowns.created_at")
    .orderBy("takedowns.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  const cells = rows.map((r): Row => [
    iso(r.created_at),
    workCell(r.title, r.ao3_work_id),
    r.requester,
    r.basis,
    r.infringing_material,
    r.signature,
    statements(r),
    r.incomplete ? "Incomplete" : "",
  ]);
  return c.html(queuePage("Takedowns", TAKEDOWN_COLUMNS, cells));
}

/** `GET /admin/requests`: pending removal and opt-out requests, both kinds. */
export async function showRequests(c: AdminContext) {
  const rows = await c.var.db
    .selectFrom("requests")
    // An opt-out names a pseud, not a work.
    .leftJoin("works", "works.id", "requests.work_id")
    .select([
      "requests.created_at",
      "requests.kind",
      "requests.pseud_norm",
      "requests.contact_email",
      "requests.statement",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("requests.status", "=", "pending")
    .orderBy("requests.created_at")
    .orderBy("requests.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  const cells = rows.map((r): Row => [
    iso(r.created_at),
    r.kind,
    r.title === null || r.ao3_work_id === null
      ? (r.pseud_norm ?? "")
      : workCell(r.title, r.ao3_work_id),
    r.contact_email,
    r.statement,
  ]);
  return c.html(queuePage("Requests", REQUEST_COLUMNS, cells));
}

/**
 * `GET /admin/works`: Works to check. MOD3 (#47) fills it; until then it says so,
 * rather than that nothing is waiting.
 */
export function showWorksToCheck(c: AdminContext) {
  return c.html(queuePage("Works to check", WORK_COLUMNS, [], "This queue is not built yet."));
}

/**
 * The area, for `app.route("/admin", admin)`. Its middleware runs for "/admin/*",
 * which matches /admin itself too and every path below it, routed or not, so a
 * later /admin route is gated without asking. The session comes from the app's
 * global mount (index.ts), so this is mounted after it. The role and database are
 * typed on this app alone: no other page has them.
 */
export const admin = new Hono<AdminEnv>();
admin.use(adminGate);
admin.get("/", showAdminHome);
admin.get("/reports", showReports);
admin.get("/takedowns", showTakedowns);
admin.get("/requests", showRequests);
admin.get("/works", showWorksToCheck);
