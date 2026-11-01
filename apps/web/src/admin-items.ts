// The detail page of each report, takedown and request under /admin, and the actions on
// them: hide and restore a work (keyed by its AO3 work ID) and reject an item (keyed by
// its own id). Mounted in admin.ts, behind `adminGate`.

import { hideWork, restoreWork } from "@archive/db";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AdminEnv } from "./admin";
import {
  itemPage,
  rejectForm,
  resultPage,
  safeFrom,
  workActions,
  workStatusText,
} from "./admin-pages";
import { readForm } from "./login";
import { isSameOrigin } from "./signin";

/** An AO3 work ID is an int4. */
const MAX_INT4 = 2_147_483_647;

/** Plenty for the one field these forms carry. */
const MAX_FORM = 1024;

/**
 * Refuses a post from anywhere but the site with the app's own not-found answer, so
 * a moderator's cross-site post and a stranger's look the same. After `adminGate`
 * (admin.ts), never before it: a 403 there would say /admin exists.
 */
export const adminSameOrigin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (c.req.method === "POST" && !isSameOrigin(c.req.raw.headers)) return c.notFound();
  await next();
};

export const adminItems = new Hono<AdminEnv>();

const iso = (date: Date) => date.toISOString();

/** The `from` field of a hide, restore or reject form, if it names an item page. */
async function fromField(request: Request) {
  const form = await readForm(request, MAX_FORM);
  return safeFrom(form?.get("from"));
}

adminItems.get("/reports/:id", async (c) => {
  const row = await c.var.db
    .selectFrom("reports")
    .innerJoin("works", "works.id", "reports.work_id")
    .select([
      "reports.created_at",
      "reports.kind",
      "reports.body",
      "reports.status",
      "works.title",
      "works.ao3_work_id",
      "works.status as work_status",
      "works.hidden_cause",
    ])
    .where("reports.id", "=", c.req.param("id"))
    .executeTakeFirst();
  if (!row) return c.notFound();
  const self = `/admin/reports/${encodeURIComponent(c.req.param("id"))}`;
  return c.html(
    itemPage(
      "Report",
      [
        ["Created", iso(row.created_at)],
        ["Status", row.status],
        ["Kind", row.kind],
        ["Details", row.body ?? ""],
        ["Work", `${row.title} (${row.ao3_work_id})`],
        ["Work status", workStatusText(row.work_status, row.hidden_cause)],
      ],
      workActions(row.ao3_work_id, self),
    ),
  );
});

adminItems.get("/takedowns/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .selectAll("takedowns")
    .select([
      "works.title",
      "works.ao3_work_id",
      "works.status as work_status",
      "works.hidden_cause",
    ])
    .where("takedowns.id", "=", id)
    .executeTakeFirst();
  if (!row) return c.notFound();
  const self = `/admin/takedowns/${encodeURIComponent(id)}`;
  return c.html(
    itemPage(
      "Takedown",
      [
        ["Created", iso(row.created_at)],
        ["Status", row.status],
        ["Requester", row.requester],
        ["Basis", row.basis],
        ["Material", row.infringing_material],
        ["Signature", row.signature],
        ["Good faith statement", row.good_faith ? "made" : "not made"],
        ["Accuracy statement", row.accuracy_authority ? "made" : "not made"],
        ["Incomplete", row.incomplete ? "Incomplete" : "no"],
        ["Work", `${row.title} (${row.ao3_work_id})`],
        ["Work status", workStatusText(row.work_status, row.hidden_cause)],
      ],
      `${workActions(row.ao3_work_id, self)}\n${row.status === "pending" ? rejectForm("takedowns", id) : ""}`,
    ),
  );
});

adminItems.get("/requests/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.db
    .selectFrom("requests")
    // An opt-out names a pseud, not a work.
    .leftJoin("works", "works.id", "requests.work_id")
    .select([
      "requests.created_at",
      "requests.kind",
      "requests.status",
      "requests.pseud_norm",
      "requests.contact_email",
      "requests.statement",
      "works.title",
      "works.ao3_work_id",
      "works.status as work_status",
      "works.hidden_cause",
    ])
    .where("requests.id", "=", id)
    .executeTakeFirst();
  if (!row) return c.notFound();
  const self = `/admin/requests/${encodeURIComponent(id)}`;
  const about: [string, string][] =
    row.title !== null && row.work_status !== null
      ? [
          ["Work", `${row.title} (${row.ao3_work_id})`],
          ["Work status", workStatusText(row.work_status, row.hidden_cause)],
        ]
      : [["Pseud", row.pseud_norm ?? ""]];
  return c.html(
    itemPage(
      "Request",
      [
        ["Created", iso(row.created_at)],
        ["Status", row.status],
        ["Kind", row.kind],
        ...about,
        ["Contact email", row.contact_email],
        ["Statement", row.statement],
      ],
      `${row.ao3_work_id === null ? "" : workActions(row.ao3_work_id, self)}\n${row.status === "pending" ? rejectForm("requests", id) : ""}`,
    ),
  );
});

/** The work with this AO3 work ID, from a URL segment, or null for no such work. */
async function workByAo3Id(c: { var: AdminEnv["Variables"] }, segment: string) {
  if (!/^\d{1,10}$/.test(segment) || Number(segment) < 1 || Number(segment) > MAX_INT4) {
    return null;
  }
  const row = await c.var.db
    .selectFrom("works")
    .select("id")
    .where("ao3_work_id", "=", Number(segment))
    .executeTakeFirst();
  return row ?? null;
}

adminItems.post("/works/:id/hide", async (c) => {
  const work = await workByAo3Id(c, c.req.param("id"));
  if (!work) return c.notFound();
  const from = await fromField(c.req.raw);
  const hid = await hideWork(c.var.db, work.id, "moderator");
  return c.html(
    resultPage(
      hid
        ? "The work is hidden by a moderator."
        : "Nothing changed: the work is not live or hidden.",
      from,
    ),
  );
});

adminItems.post("/works/:id/restore", async (c) => {
  const work = await workByAo3Id(c, c.req.param("id"));
  if (!work) return c.notFound();
  const from = await fromField(c.req.raw);
  const restored = await restoreWork(c.var.db, work.id);
  return c.html(
    resultPage(
      restored ? "The work is live again." : "Nothing changed: the work is not hidden.",
      from,
    ),
  );
});

adminItems.post("/requests/:id/reject", async (c) => {
  const id = c.req.param("id");
  const rejected = await c.var.db
    .updateTable("requests")
    .set({ status: "rejected" })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .returning("work_id")
    .executeTakeFirst();
  if (!rejected) return decidedOrMissing(c, "requests", id);
  // The hide this request caused comes off, never a moderator's or the reports'.
  const restored =
    rejected.work_id !== null &&
    (await restoreWork(c.var.db, rejected.work_id, { cause: "removal_request" }));
  return c.html(
    resultPage(
      restored ? "Rejected. The work is live again." : "Rejected.",
      `/admin/requests/${encodeURIComponent(id)}`,
    ),
  );
});

adminItems.post("/takedowns/:id/reject", async (c) => {
  const id = c.req.param("id");
  const rejected = await c.var.db
    .updateTable("takedowns")
    .set({ status: "rejected", resolved_by: c.var.session?.user.id ?? null })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .returning("id")
    .executeTakeFirst();
  if (!rejected) return decidedOrMissing(c, "takedowns", id);
  return c.html(resultPage("Rejected.", `/admin/takedowns/${encodeURIComponent(id)}`));
});

/** A reject that changed no row: 404 for an item that isn't there, else it was decided already. */
async function decidedOrMissing(c: Context<AdminEnv>, table: "requests" | "takedowns", id: string) {
  const exists = await c.var.db
    .selectFrom(table)
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!exists) return c.notFound();
  return c.html(resultPage("Nothing changed: it was decided already.", null));
}
