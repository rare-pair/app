// The detail page of each report, takedown and request under /admin, and the actions on
// them: hide, restore and remove a work (keyed by its AO3 work ID), and reject or approve an
// item (keyed by its own id; approving a request or a takedown removes the work). Mounted in admin.ts, behind `adminGate`.

import { dismissReport, hideWork, logModerationAction, restoreWork } from "@archive/db";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AdminEnv } from "./admin";
import {
  approveConfirmPage,
  approveForm,
  blockRequesterForm,
  dismissForm,
  itemPage,
  QUEUE_LIMIT,
  rejectForm,
  relatedTable,
  restoreRelatedForm,
  removeConfirmPage,
  resultPage,
  safeFrom,
  unconfirmedMark,
  workActions,
  workStatusText,
} from "./admin-pages";
import {
  lockLinkedWorks,
  relatedRequests,
  restoreOwnWorks,
  restoredNote,
} from "./admin-request-actions";
import { readForm } from "./login";
import { applyOptOut } from "./remove-confirm";
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

/** The forms that decide a pending item: reject and approve, each labelled for what it does. */
const decideForms = (
  queue: "takedowns" | "requests",
  id: string,
  labels: { approve?: string; reject?: string } = {},
) => `${rejectForm(queue, id, labels.reject)}\n${approveForm(queue, id, labels.approve)}`;

/** The actions on a request's page: decide it by what it is, and restore the works of the spree it belongs to. */
function requestForms(
  id: string,
  request: { kind: string; status: string; confirmed_at: Date | null },
  hasRelated: boolean,
) {
  const forms: string[] = [];
  // Approve is for a request its requester has confirmed (X3b, #487): an unconfirmed one
  // can only be rejected.
  const confirmed = request.confirmed_at !== null;
  if (request.kind === "opt_out") {
    // Rejecting an opt-out reverses it, pending or approved.
    if (request.status === "pending" && confirmed) {
      forms.push(
        decideForms("requests", id, {
          approve: "Confirm opt-out",
          reject: "Reject and reverse opt-out",
        }),
      );
    } else if (request.status === "pending") {
      forms.push(rejectForm("requests", id));
    } else if (request.status === REQUEST_APPROVED) {
      forms.push(rejectForm("requests", id, "Reverse opt-out"));
    }
  } else if (request.status === "pending") {
    forms.push(confirmed ? decideForms("requests", id) : rejectForm("requests", id));
  }
  if (request.kind === "remove_work" || hasRelated) forms.push(restoreRelatedForm(id));
  // For a request of any status: a moderator who sees a spree can block the requester after.
  forms.push(blockRequesterForm(id));
  return forms.join("\n");
}

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
  const id = c.req.param("id");
  const self = `/admin/reports/${encodeURIComponent(id)}`;
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
      `${workActions(row.ao3_work_id, self)}\n${row.status === "open" ? dismissForm(id) : ""}`,
    ),
  );
});

/** Dismissing a report closes it and leaves the work as it is, hidden or live. */
adminItems.post("/reports/:id{[A-Za-z0-9_-]+}/dismiss", async (c) => {
  const id = c.req.param("id");
  const outcome = await dismissReport(c.var.db, id, { actor: c.var.userId });
  if (outcome === "missing") return c.notFound();
  if (outcome === "closed") return alreadyDecided(c);
  return c.html(
    resultPage(
      "Report dismissed. The work stays as it is.",
      `/admin/reports/${encodeURIComponent(id)}`,
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
      "requests.ip_hash",
      "requests.statement",
      "requests.confirmed_at",
      "works.title",
      "works.ao3_work_id",
      "works.status as work_status",
      "works.hidden_cause",
    ])
    .where("requests.id", "=", id)
    .executeTakeFirst();
  if (!row) return c.notFound();
  // The same contact email or IP hash; the hash itself is never shown.
  const related = await relatedRequests(c.var.db, {
    id,
    contactEmail: row.contact_email,
    ipHash: row.ip_hash,
  })
    .leftJoin("works", "works.id", "requests.work_id")
    .select([
      "requests.id",
      "requests.created_at",
      "requests.kind",
      "requests.status",
      "requests.pseud_norm",
      "requests.confirmed_at",
      "works.title",
      "works.ao3_work_id",
    ])
    .orderBy("requests.created_at")
    .orderBy("requests.id")
    .limit(QUEUE_LIMIT + 1)
    .execute();
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
        ["Status", `${row.status}${unconfirmedMark(row.confirmed_at)}`],
        ["Kind", row.kind],
        ...about,
        ["Contact email", row.contact_email],
        ["Statement", row.statement],
      ],
      `${row.ao3_work_id === null ? "" : workActions(row.ao3_work_id, self)}\n${requestForms(
        id,
        row,
        related.length > QUEUE_LIMIT || related.some((r) => r.kind === "remove_work"),
      )}\n${relatedTable(
        related.slice(0, QUEUE_LIMIT).map((r) => ({
          cells: [
            iso(r.created_at),
            r.kind,
            r.ao3_work_id === null ? (r.pseud_norm ?? "") : `${r.title ?? ""} (${r.ao3_work_id})`,
            `${r.status}${unconfirmedMark(r.confirmed_at)}`,
          ],
          href: `/admin/requests/${encodeURIComponent(r.id)}`,
        })),
        related.length > QUEUE_LIMIT,
      )}`,
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
  if (removed.outcome !== "processing") await markTakedownsRemoved(c, work.id);
  return removedPage(c, removed, from);
});

/**
 * After a work is removed for good, by any path: marks every pending takedown on it `removed`,
 * which puts its AO3 work ID on the takedown list, and logs each as an approve. Safe to repeat.
 */
async function markTakedownsRemoved(c: Context<AdminEnv>, workId: string) {
  await c.var.db.transaction().execute(async (trx) => {
    const marked = await trx
      .updateTable("takedowns")
      .set({ status: TAKEDOWN_APPROVED, resolved_by: c.var.userId })
      .where("work_id", "=", workId)
      .where("status", "=", "pending")
      .returning("id")
      .execute();
    for (const { id } of marked) {
      await logModerationAction(trx, {
        moderatorId: c.var.userId,
        action: "approve",
        targetKind: "takedown",
        targetId: id,
      });
    }
  });
}

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

/**
 * Rejecting a request marks it `rejected` and brings back the works it hid. For an opt-out,
 * pending or approved, that is also its reversal: its `optouts` row goes inactive, so new
 * uploads by the pseud are accepted again. Only the works the request's own `request_works`
 * rows name come back, and none that something else still covers (admin-request-actions.ts).
 */
adminItems.post("/requests/:id{[A-Za-z0-9_-]+}/reject", async (c) => {
  const id = c.req.param("id");
  // One transaction: the status, the hide coming off and the log row stand or fall
  // together. Inside it only `trx` is used: `c.var.db` has one connection, which the
  // transaction holds.
  const decided = await c.var.db.transaction().execute(async (trx) => {
    const asked = await trx
      .selectFrom("requests")
      .select("kind")
      .where("id", "=", id)
      // Requests before works, as the bulk restore locks them.
      .forUpdate()
      .executeTakeFirst();
    if (!asked) return null;
    const optOut = asked.kind === "opt_out";
    // Lock the works first: two moderators deciding the last two requests at once
    // must not each see the other's as pending (the check in `restoreWork` reads
    // only committed rows) and leave a work hidden for good. The second waits
    // here for the first to commit.
    const linked = (await lockLinkedWorks(trx, [id])).get(id) ?? [];
    const rejected = await trx
      .updateTable("requests")
      .set({ status: "rejected" })
      .where("id", "=", id)
      // An approved opt-out can still be reversed; an approved removal is done.
      .where("status", "in", optOut ? ["pending", REQUEST_APPROVED] : ["pending"])
      .returning("id")
      .executeTakeFirst();
    if (!rejected) return null;
    if (optOut) {
      await trx
        .updateTable("optouts")
        .set({ active: false })
        .where("request_id", "=", id)
        .execute();
    }
    // The hide a request caused comes off, never a moderator's or the reports', and
    // not while something else covers the work. It is a consequence of the reject, so
    // only the reject is logged, with the works it brought back in its note.
    const { restored, covered } = await restoreOwnWorks(trx, id, linked, new Set());
    await logModerationAction(trx, {
      moderatorId: c.var.userId,
      action: "reject",
      targetKind: "request",
      targetId: id,
      note: restoredNote(restored, optOut ? "Opt-out reversed. " : ""),
    });
    return { restored: restored.length, covered: covered.length, optOut };
  });
  if (!decided) return decidedOrMissing(c, "requests", id);
  const lifted =
    decided.restored === 0
      ? ""
      : ` ${decided.restored} work${decided.restored === 1 ? " is" : "s are"} live again.`;
  const held =
    decided.covered === 0
      ? ""
      : ` ${decided.covered} work${decided.covered === 1 ? " stays" : "s stay"} hidden: something else still covers ${decided.covered === 1 ? "it" : "them"}.`;
  return c.html(
    resultPage(
      `Rejected.${decided.optOut ? " The opt-out is no longer active." : ""}${lifted}${held}`,
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

/** Approving a removal request removes its work, then marks the request `approved` (and, like any removal, the work's pending takedowns `removed`); it asks to confirm first. */
adminItems.post("/requests/:id{[A-Za-z0-9_-]+}/approve", async (c) => {
  const id = c.req.param("id");
  const item = await c.var.db
    .selectFrom("requests")
    .leftJoin("works", "works.id", "requests.work_id")
    .select([
      "requests.kind",
      "requests.status",
      "requests.confirmed_at",
      "works.id as work_id",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("requests.id", "=", id)
    .executeTakeFirst();
  if (!item) return c.notFound();
  if (item.status !== "pending") return decidedOrMissing(c, "requests", id);
  // Its requester hasn't confirmed it, so it hid nothing and can't be approved yet (X3b,
  // #487). Nothing changes. A request only ever goes from unconfirmed to confirmed, so
  // this read can't be stale in the unsafe direction.
  if (item.confirmed_at === null) return notConfirmed(c);
  if (item.kind === "opt_out") return confirmOptOut(c, id);
  if (item.work_id === null) return c.notFound();
  return approveRemoval(c, "requests", id, {
    workId: item.work_id,
    title: item.title ?? "",
    ao3WorkId: item.ao3_work_id ?? 0,
  });
});

/**
 * Confirming an opt-out marks it `approved` and logs `approve`. A requester's own confirmation
 * already added its active `optouts` row and hid the works (remove-confirm.ts), so then
 * nothing else changes and nothing is removed, so there is no confirm step; rejecting it
 * reverses it. A blocked requester's confirmation did neither: with no `optouts` row for the
 * request, approving it applies the opt-out now, with the same code, request row locked first.
 */
async function confirmOptOut(c: Context<AdminEnv>, id: string) {
  const outcome = await c.var.db.transaction().execute(async (trx) => {
    const marked = await trx
      .updateTable("requests")
      .set({ status: REQUEST_APPROVED })
      .where("id", "=", id)
      .where("kind", "=", "opt_out")
      .where("status", "=", "pending")
      .returning(["id", "pseud_norm"])
      .executeTakeFirst();
    if (!marked) return null;
    const existing = await trx
      .selectFrom("optouts")
      .select("id")
      .where("request_id", "=", id)
      .executeTakeFirst();
    const pseud = marked.pseud_norm;
    const applies = existing === undefined && pseud !== null;
    if (applies) await applyOptOut(trx, { id, pseud_norm: pseud });
    await logModerationAction(trx, {
      moderatorId: c.var.userId,
      action: "approve",
      targetKind: "request",
      targetId: id,
    });
    return { applied: applies };
  });
  if (!outcome) return decidedOrMissing(c, "requests", id);
  return c.html(
    resultPage(
      outcome.applied
        ? "Confirmed. The opt-out is now active and the works by the pseud are hidden."
        : "Confirmed. The opt-out stays active and the works stay hidden.",
      `/admin/requests/${encodeURIComponent(id)}`,
    ),
  );
}

/** Approving a takedown removes its work and sets the takedown `removed`, which puts the work's AO3 work ID on the takedown list. */
adminItems.post("/takedowns/:id{[A-Za-z0-9_-]+}/approve", async (c) => {
  const id = c.req.param("id");
  const item = await c.var.db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .select([
      "takedowns.status",
      "takedowns.incomplete",
      "works.id as work_id",
      "works.title",
      "works.ao3_work_id",
    ])
    .where("takedowns.id", "=", id)
    .executeTakeFirst();
  if (!item) return c.notFound();
  if (item.status !== "pending") return decidedOrMissing(c, "takedowns", id);
  return approveRemoval(
    c,
    "takedowns",
    id,
    { workId: item.work_id, title: item.title, ao3WorkId: item.ao3_work_id },
    item.incomplete,
  );
});

/**
 * The steps both approves share, for an item found pending: ask to confirm, remove the
 * work, then mark the item and log `approve`, then mark the work's other pending takedowns. The removal comes first: a crash between
 * leaves a removed work and a pending item, which approving again completes; marking
 * first could leave an approved item over a live work.
 */
async function approveRemoval(
  c: Context<AdminEnv>,
  queue: "requests" | "takedowns",
  id: string,
  work: { workId: string; title: string; ao3WorkId: number },
  incomplete = false,
) {
  const form = await readForm(c.req.raw, MAX_FORM);
  const self = `/admin/${queue}/${encodeURIComponent(id)}`;
  if (form?.get("confirm") !== "yes") {
    return c.html(approveConfirmPage(queue, id, work.title, work.ao3WorkId, incomplete));
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
  await markTakedownsRemoved(c, work.workId);
  // Someone decided the item after the pending check: the removal has happened (and is safe
  // to repeat), but this approve did not mark or log, and must not say it did.
  if (!decided) {
    return c.html(
      resultPage(
        `The work is removed, but the item was decided by someone else first, so it is unchanged.${removed.caches === "failed" ? " Clearing the caches failed: use Remove on the work to retry." : ""}`,
        self,
      ),
      removed.caches === "failed" ? 502 : 200,
    );
  }
  // Marked even when the purge failed: Remove on the work retries it.
  return removedPage(c, removed, self);
}

/** An approve of a request whose requester hasn't confirmed it: refused, and nothing changed. */
const notConfirmed = (c: Context<AdminEnv>) =>
  c.html(
    resultPage(
      "Nothing changed: its requester has not confirmed it yet, so it can't be approved. You can reject it.",
      null,
    ),
    409,
  );

/** The answer to deciding an item that someone already decided. */
const alreadyDecided = (c: Context<AdminEnv>) =>
  c.html(resultPage("Nothing changed: it was decided already.", null));

/** A reject that changed no row: 404 for an item that isn't there, else it was decided already. */
async function decidedOrMissing(c: Context<AdminEnv>, table: "requests" | "takedowns", id: string) {
  const exists = await c.var.db
    .selectFrom(table)
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!exists) return c.notFound();
  return alreadyDecided(c);
}
