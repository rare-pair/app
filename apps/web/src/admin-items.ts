// The detail page of each report, takedown and request under /admin, and the actions on
// them: hide, restore and remove a work (keyed by its AO3 work ID), and reject or approve an
// item (keyed by its own id; approving a request or a takedown removes the work). Mounted in admin.ts, behind `adminGate`.

import { hideWork, logModerationAction, restoreWork } from "@archive/db";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AdminEnv } from "./admin";
import {
  approveConfirmPage,
  approveForm,
  itemPage,
  rejectForm,
  removeConfirmPage,
  resultPage,
  safeFrom,
  workActions,
  workStatusText,
} from "./admin-pages";
import { readForm } from "./login";
import { removeDeps, removeWorkEverywhere, type RemoveResult } from "./remove-work";
import { isSameOrigin } from "./signin";

/** An AO3 work ID is an int4. */
const MAX_INT4 = 2_147_483_647;

/** Plenty for the fields these forms carry: `from`, and `confirm` on a remove. */
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

/** The forms that decide a pending item: reject, and approve where approving removes a work. */
const decideForms = (queue: "takedowns" | "requests", id: string, canApprove = true) =>
  `${rejectForm(queue, id)}${canApprove ? `\n${approveForm(queue, id)}` : ""}`;

/** An approved takedown's `status`: the value the ingest takedown list reads (`TAKEDOWN_REMOVED`, apps/ingest/src/lists.ts). */
const TAKEDOWN_APPROVED = "removed";

/** An approved removal request's `status`. */
const REQUEST_APPROVED = "approved";

/** The `from` field of a hide, restore, reject or ban form, if it names a page to go back to (remove reads its form itself, for `confirm`). */
export async function fromField(request: Request) {
  const form = await readForm(request, MAX_FORM);
  return safeFrom(form?.get("from"));
}

adminItems.get("/reports/:id{[A-Za-z0-9_-]+}", async (c) => {
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
    // Not an item of the Reports queue (it only queues the work in Works to check).
    .where("reports.kind", "<>", "wrong_version")
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

adminItems.get("/takedowns/:id{[A-Za-z0-9_-]+}", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .select([
      "takedowns.created_at",
      "takedowns.status",
      "takedowns.requester",
      "takedowns.basis",
      "takedowns.infringing_material",
      "takedowns.signature",
      "takedowns.good_faith",
      "takedowns.accuracy_authority",
      "takedowns.incomplete",
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
      `${workActions(row.ao3_work_id, self)}\n${row.status === "pending" ? decideForms("takedowns", id) : ""}`,
    ),
  );
});

adminItems.get("/requests/:id{[A-Za-z0-9_-]+}", async (c) => {
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
      `${row.ao3_work_id === null ? "" : workActions(row.ao3_work_id, self)}\n${row.status === "pending" ? decideForms("requests", id, row.kind === "remove_work") : ""}`,
    ),
  );
});

/** The work with this AO3 work ID, from a URL segment, or null for no such work. */
export async function workByAo3Id(c: Context<AdminEnv>, segment: string) {
  if (!/^\d{1,10}$/.test(segment) || Number(segment) < 1 || Number(segment) > MAX_INT4) {
    return null;
  }
  const row = await c.var.db
    .selectFrom("works")
    .select(["id", "title", "ao3_work_id"])
    .where("ao3_work_id", "=", Number(segment))
    .executeTakeFirst();
  return row ?? null;
}

adminItems.post("/works/:id/hide", async (c) => {
  const work = await workByAo3Id(c, c.req.param("id"));
  if (!work) return c.notFound();
  const from = await fromField(c.req.raw);
  const hid = await hideWork(c.var.db, work.id, "moderator", { actor: c.var.userId });
  return c.html(
    resultPage(
      hid
        ? "The work is hidden by a moderator."
        : "Nothing changed: the work is not live, or a moderator already hid it.",
      from,
    ),
  );
});

adminItems.post("/works/:id/restore", async (c) => {
  const work = await workByAo3Id(c, c.req.param("id"));
  if (!work) return c.notFound();
  const from = await fromField(c.req.raw);
  const restored = await restoreWork(c.var.db, work.id, { actor: c.var.userId });
  return c.html(
    resultPage(
      restored ? "The work is live again." : "Nothing changed: the work is not hidden.",
      from,
    ),
  );
});

adminItems.post("/works/:id/remove", async (c) => {
  const work = await workByAo3Id(c, c.req.param("id"));
  if (!work) return c.notFound();
  const form = await readForm(c.req.raw, MAX_FORM);
  const from = safeFrom(form?.get("from"));
  if (form?.get("confirm") !== "yes") {
    return c.html(removeConfirmPage(work.title, work.ao3_work_id, from));
  }
  const removed = await removeWorkEverywhere(removeDeps(c.env, c.var.db), work.id, c.var.userId);
  if (!removed) return c.notFound();
  return removedPage(c, removed, from);
});

/** The page for what a removal did. A failed purge is a 502: the removal stands, and a repeat remove retries it. */
function removedPage(c: Context<AdminEnv>, removed: RemoveResult, from: string | null) {
  if (removed.outcome === "processing") {
    return c.html(
      resultPage("Nothing changed: the work is still processing. Try again shortly.", from),
    );
  }
  if (removed.caches === "failed") {
    return c.html(
      resultPage(
        "The work is removed and its files are deleted, but clearing the caches failed. Use Remove again to retry.",
        from,
      ),
      502,
    );
  }
  return c.html(
    resultPage(
      removed.outcome === "removed"
        ? "The work is removed and its files are deleted. Its caches are cleared."
        : "The work was already removed. Its files were deleted again and its caches cleared.",
      from,
    ),
  );
}

adminItems.post("/requests/:id{[A-Za-z0-9_-]+}/reject", async (c) => {
  const id = c.req.param("id");
  // One transaction: the status, the hide coming off and the log row stand or fall
  // together. Inside it only `trx` is used: `c.var.db` has one connection, which the
  // transaction holds.
  const decided = await c.var.db.transaction().execute(async (trx) => {
    // Lock the work first: two moderators deciding the last two requests at once
    // must not each see the other's as pending (the check in `restoreWork` reads
    // only committed rows) and leave the work hidden for good. The second waits
    // here for the first to commit.
    const asked = await trx
      .selectFrom("requests")
      .select("work_id")
      .where("id", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (asked?.work_id) {
      await trx
        .selectFrom("works")
        .select("id")
        .where("id", "=", asked.work_id)
        .forNoKeyUpdate()
        .execute();
    }
    const rejected = await trx
      .updateTable("requests")
      .set({ status: "rejected" })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .returning("work_id")
      .executeTakeFirst();
    if (!rejected) return null;
    // The hide a request caused comes off, never a moderator's or the reports', and
    // not while another removal request for the work is still waiting. It is a
    // consequence of the reject, so only the reject is logged.
    const restored =
      rejected.work_id !== null &&
      (await restoreWork(trx, rejected.work_id, {
        cause: "removal_request",
        noPendingRequests: true,
      }));
    await logModerationAction(trx, {
      moderatorId: c.var.userId,
      action: "reject",
      targetKind: "request",
      targetId: id,
    });
    return { restored };
  });
  if (!decided) return decidedOrMissing(c, "requests", id);
  const { restored } = decided;
  return c.html(
    resultPage(
      restored ? "Rejected. The work is live again." : "Rejected.",
      `/admin/requests/${encodeURIComponent(id)}`,
    ),
  );
});

adminItems.post("/takedowns/:id{[A-Za-z0-9_-]+}/reject", async (c) => {
  const id = c.req.param("id");
  const rejected = await c.var.db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("takedowns")
      .set({ status: "rejected", resolved_by: c.var.userId })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .returning("id")
      .executeTakeFirst();
    if (!row) return null;
    await logModerationAction(trx, {
      moderatorId: c.var.userId,
      action: "reject",
      targetKind: "takedown",
      targetId: id,
    });
    return row;
  });
  if (!rejected) return decidedOrMissing(c, "takedowns", id);
  return c.html(resultPage("Rejected.", `/admin/takedowns/${encodeURIComponent(id)}`));
});

/** Approving a removal request removes its work, then marks the request `approved`; it asks to confirm first. */
adminItems.post("/requests/:id{[A-Za-z0-9_-]+}/approve", async (c) => {
  const id = c.req.param("id");
  const item = await c.var.db
    .selectFrom("requests")
    .leftJoin("works", "works.id", "requests.work_id")
    .select([
      "requests.kind",
      "requests.status",
      "works.id as work_id",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("requests.id", "=", id)
    .executeTakeFirst();
  // An opt-out names a pseud and is decided elsewhere: to this route it is not a request.
  if (!item || item.kind !== "remove_work" || item.work_id === null) return c.notFound();
  if (item.status !== "pending") return decidedOrMissing(c, "requests", id);
  return approveRemoval(c, "requests", id, {
    workId: item.work_id,
    title: item.title ?? "",
    ao3WorkId: item.ao3_work_id ?? 0,
  });
});

/** Approving a takedown removes its work and sets the takedown `removed`, which puts the work's AO3 work ID on the takedown list. */
adminItems.post("/takedowns/:id{[A-Za-z0-9_-]+}/approve", async (c) => {
  const id = c.req.param("id");
  const item = await c.var.db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .select(["takedowns.status", "works.id as work_id", "works.title", "works.ao3_work_id"])
    .where("takedowns.id", "=", id)
    .executeTakeFirst();
  if (!item) return c.notFound();
  if (item.status !== "pending") return decidedOrMissing(c, "takedowns", id);
  return approveRemoval(c, "takedowns", id, {
    workId: item.work_id,
    title: item.title,
    ao3WorkId: item.ao3_work_id,
  });
});

/**
 * The steps both approves share, for an item found pending: ask to confirm, remove the
 * work, then mark the item and log `approve`. The removal comes first: a crash between
 * leaves a removed work and a pending item, which approving again completes; marking
 * first could leave an approved item over a live work.
 */
async function approveRemoval(
  c: Context<AdminEnv>,
  queue: "requests" | "takedowns",
  id: string,
  work: { workId: string; title: string; ao3WorkId: number },
) {
  const form = await readForm(c.req.raw, MAX_FORM);
  const self = `/admin/${queue}/${encodeURIComponent(id)}`;
  if (form?.get("confirm") !== "yes") {
    return c.html(approveConfirmPage(queue, id, work.title, work.ao3WorkId));
  }
  const removed = await removeWorkEverywhere(
    removeDeps(c.env, c.var.db),
    work.workId,
    c.var.userId,
  );
  if (!removed) return c.notFound();
  // Still processing: nothing changed, so the item stays pending.
  if (removed.outcome === "processing") return removedPage(c, removed, self);
  // Inside the transaction only `trx` is used: `c.var.db` has one connection, which it holds.
  const decided = await c.var.db.transaction().execute(async (trx) => {
    const marked =
      queue === "requests"
        ? await trx
            .updateTable("requests")
            .set({ status: REQUEST_APPROVED })
            .where("id", "=", id)
            .where("status", "=", "pending")
            .returning("id")
            .executeTakeFirst()
        : await trx
            .updateTable("takedowns")
            .set({ status: TAKEDOWN_APPROVED, resolved_by: c.var.userId })
            .where("id", "=", id)
            .where("status", "=", "pending")
            .returning("id")
            .executeTakeFirst();
    if (!marked) return false;
    await logModerationAction(trx, {
      moderatorId: c.var.userId,
      action: "approve",
      targetKind: queue === "requests" ? "request" : "takedown",
      targetId: id,
    });
    return true;
  });
  // Someone decided the item after the pending check: the removal has happened (and is safe
  // to repeat), but this approve did not mark or log, and must not say it did.
  if (!decided) {
    return c.html(
      resultPage(
        "The work is removed, but the item was decided by someone else first, so it is unchanged.",
        self,
      ),
      removed.caches === "failed" ? 502 : 200,
    );
  }
  // Marked even when the purge failed: Remove on the work retries it.
  return removedPage(c, removed, self);
}

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
