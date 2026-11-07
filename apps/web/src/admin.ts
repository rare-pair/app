// The moderation area under /admin (FRONTEND-DISCOVERY, Moderation queues): the gate
// every /admin URL goes through, and the four queues, read only. Actions and detail
// pages come with later tickets (MOD2 on).

import { createDb, isModeratorRole, type Database, type ModeratorRole } from "@archive/db";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { sql, type Kysely } from "kysely";
import {
  adminHomePage,
  QUEUE_LIMIT,
  queuePage,
  REPORT_COLUMNS,
  REQUEST_COLUMNS,
  TAKEDOWN_COLUMNS,
  unconfirmedMark,
  WORK_COLUMNS,
  type Row,
} from "./admin-pages";
import { adminItems, adminSameOrigin } from "./admin-items";
import { adminRequestActions } from "./admin-request-actions";
import { adminUsers } from "./admin-users";
import { adminWork } from "./admin-work";
import type { Bindings } from "./env";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";

export type { ModeratorRole };

/** Set by `adminGate` for every /admin handler: the moderator's role, user id, and the request's database. */
export type AdminVariables = { role: ModeratorRole; db: Kysely<Database>; userId: string };

export type AdminEnv = {
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables & AdminVariables;
};

/** Exactly a role with moderator powers: the same rule a ban's `protected` uses. */
export const isModerator = isModeratorRole;

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
    c.set("userId", userId);
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

/** The detail page of a queue row, by the row's own id. */
const itemHref = (queue: string, id: string) => `/admin/${queue}/${encodeURIComponent(id)}`;

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
      "reports.id",
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
  const cells = rows.map((r): Row => ({
    href: itemHref("reports", r.id),
    cells: [iso(r.created_at), workCell(r.title, r.ao3_work_id), r.kind, r.body ?? ""],
  }));
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
      "takedowns.id",
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
  const cells = rows.map((r): Row => ({
    href: itemHref("takedowns", r.id),
    cells: [
      iso(r.created_at),
      workCell(r.title, r.ao3_work_id),
      r.requester,
      r.basis,
      r.infringing_material,
      r.signature,
      statements(r),
      r.incomplete ? "Incomplete" : "",
    ],
  }));
  return c.html(queuePage("Takedowns", TAKEDOWN_COLUMNS, cells));
}

/** `GET /admin/requests`: pending removal and opt-out requests, both kinds. */
export async function showRequests(c: AdminContext) {
  const rows = await c.var.db
    .selectFrom("requests")
    // An opt-out names a pseud, not a work.
    .leftJoin("works", "works.id", "requests.work_id")
    .select([
      "requests.id",
      "requests.created_at",
      "requests.kind",
      "requests.pseud_norm",
      "requests.contact_email",
      "requests.statement",
      "requests.confirmed_at",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("requests.status", "=", "pending")
    .orderBy("requests.created_at")
    .orderBy("requests.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  const cells = rows.map((r): Row => ({
    href: itemHref("requests", r.id),
    cells: [
      iso(r.created_at),
      `${r.kind}${unconfirmedMark(r.confirmed_at)}`,
      r.title === null || r.ao3_work_id === null
        ? (r.pseud_norm ?? "")
        : workCell(r.title, r.ao3_work_id),
      r.contact_email,
      r.statement,
    ],
  }));
  return c.html(queuePage("Requests", REQUEST_COLUMNS, cells));
}

/** One work in Works to check: its earliest trigger, and what each trigger said. */
type Check = { title: string; ao3WorkId: number; created: Date; reasons: string[] };

/**
 * `GET /admin/works`: Works to check. One row per work, oldest trigger first, for
 * any of: a version held for review, a live current version whose review reasons no
 * moderator has cleared, an open "This version is wrong" report, or a hide by
 * reports with none left open (nothing else queues such a work). Removed works are
 * not listed; hidden ones are. Each row links to the work's admin page, which has the actions.
 */
export async function showWorksToCheck(c: AdminContext) {
  const { db } = c.var;
  const held = await db
    .selectFrom("work_versions")
    .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
    .innerJoin("works", "works.id", "work_versions.work_id")
    .select(["works.id", "works.title", "works.ao3_work_id"])
    .select((eb) => eb.fn.min("work_versions.created_at").as("created_at"))
    .where("uploads.status", "=", "held_for_review")
    .where("works.status", "<>", "removed")
    // One row per work, so a work with many held versions can't use up the cap.
    .groupBy(["works.id", "works.title", "works.ao3_work_id"])
    .orderBy("created_at")
    .orderBy("works.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  // The notice's own rule (review-notice.ts), on the current version only. A hidden
  // work is listed too: it still needs its check.
  const flagged = await db
    .selectFrom("works")
    .innerJoin("work_versions", "work_versions.id", "works.current_version_id")
    .select([
      "works.id",
      "works.title",
      "works.ao3_work_id",
      "work_versions.created_at",
      "work_versions.review_reasons",
    ])
    .where("works.status", "<>", "removed")
    .where("work_versions.checked_at", "is", null)
    .where(sql<boolean>`cardinality(work_versions.review_reasons) > 0`)
    .orderBy("work_versions.created_at")
    .orderBy("works.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  const wrong = await db
    .selectFrom("reports")
    .innerJoin("works", "works.id", "reports.work_id")
    .select(["works.id", "works.title", "works.ao3_work_id"])
    .select((eb) => eb.fn.min("reports.created_at").as("created_at"))
    .where("reports.kind", "=", "wrong_version")
    .where("reports.status", "=", "open")
    .where("works.status", "<>", "removed")
    .groupBy(["works.id", "works.title", "works.ao3_work_id"])
    .orderBy("created_at")
    .orderBy("works.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
  // Hidden by reports, and in the Reports queue no longer: no open report but a wrong-version one.
  // No hide time is stored, so it is dated by the work's earliest report, else its current version.
  const hiddenByReports = await db
    .selectFrom("works")
    .leftJoin("work_versions", "work_versions.id", "works.current_version_id")
    .select(["works.id", "works.title", "works.ao3_work_id"])
    .select((eb) =>
      eb
        .fn<Date>("coalesce", [
          eb
            .selectFrom("reports")
            .select((e) => e.fn.min("reports.created_at").as("first"))
            .whereRef("reports.work_id", "=", "works.id"),
          "work_versions.created_at",
          // Never null, so a work with neither can't break the sort.
          sql<Date>`now()`,
        ])
        .as("created_at"),
    )
    .where("works.status", "=", "hidden")
    .where("works.hidden_cause", "=", "reports")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("reports")
            .select("reports.id")
            .whereRef("reports.work_id", "=", "works.id")
            .where("reports.status", "=", "open")
            .where("reports.kind", "not in", ["wrong_version", "higher_rating"]),
        ),
      ),
    )
    .orderBy("created_at")
    .orderBy("works.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();

  const byWork = new Map<string, Check>();
  const add = (
    r: { id: string; title: string; ao3_work_id: number; created_at: Date },
    reason: string,
  ) => {
    const have = byWork.get(r.id);
    if (have === undefined) {
      byWork.set(r.id, {
        title: r.title,
        ao3WorkId: r.ao3_work_id,
        created: r.created_at,
        reasons: [reason],
      });
    } else {
      if (r.created_at < have.created) have.created = r.created_at;
      if (!have.reasons.includes(reason)) have.reasons.push(reason);
    }
  };
  for (const r of held) add(r, "Held version");
  for (const r of flagged) add(r, `Review reasons: ${r.review_reasons.join(", ")}`);
  for (const r of wrong) add(r, "Reported: this version is wrong");
  for (const r of hiddenByReports) add(r, "Hidden by reports, none open: restore or remove");

  const rows = [...byWork.entries()]
    .sort(([aId, a], [bId, b]) => +a.created - +b.created || (aId < bId ? -1 : aId > bId ? 1 : 0))
    .slice(0, QUEUE_LIMIT + 1)
    .map(([, w]): Row => ({
      href: `/admin/works/${w.ao3WorkId}`,
      cells: [iso(w.created), workCell(w.title, w.ao3WorkId), w.reasons.join("; ")],
    }));
  return c.html(queuePage("Works to check", WORK_COLUMNS, rows));
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
// After the gate, so a cross-site post gets the same 404 as any other refusal.
admin.use(adminSameOrigin);
admin.get("/", showAdminHome);
admin.get("/reports", showReports);
admin.get("/takedowns", showTakedowns);
admin.get("/requests", showRequests);
admin.get("/works", showWorksToCheck);
admin.route("/", adminItems);
admin.route("/", adminRequestActions);
admin.route("/", adminWork);
admin.route("/", adminUsers);
