// What a moderator can do with a request beyond approving or rejecting it alone: see the
// other requests from the same contact email or IP, restore the works a spree of them hid in
// one go, and reverse an opt-out. The shared rule is which hidden works may come back:
// only the works a request's own `request_works` rows say it hid, and never one something
// else still covers (another pending removal request, or another active opt-out that names
// one of its authors). Mounted in admin.ts behind `adminGate`, like admin-items.ts.

import { logModerationAction, normalizePseud, restoreWork, type Database } from "@archive/db";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import type { AdminEnv } from "./admin";
import { resultPage } from "./admin-pages";
import { ipHash } from "./ip-hash";

export const adminRequestActions = new Hono<AdminEnv>();

/** The longest a log note may be (`logModerationAction`). */
const NOTE_MAX = 200;

/** The requests that share this one's contact email (any case) or its IP hash. */
export const relatedRequests = (
  db: Kysely<Database>,
  request: { id: string; contactEmail: string; ipHash: string },
) =>
  db
    .selectFrom("requests")
    .where("requests.id", "<>", request.id)
    .where((eb) =>
      eb.or([
        eb(
          sql<string>`lower(requests.contact_email)`,
          "=",
          sql<string>`lower(${request.contactEmail})`,
        ),
        eb("requests.ip_hash", "=", request.ipHash),
      ]),
    );

/** A work a request hid, as the lock read it. */
export interface LockedWork {
  id: string;
  ao3WorkId: number;
  status: string;
  hiddenCause: string | null;
}

/**
 * Locks every work the given requests hid (their `request_works` rows) in id order, and
 * returns each request's works. Locking in id order, as the submit path does, keeps
 * overlapping actions from deadlocking; locking before any status change keeps two
 * moderators from each seeing the other's request as pending.
 */
export async function lockLinkedWorks(trx: Kysely<Database>, requestIds: string[]) {
  const linked = new Map<string, LockedWork[]>();
  if (requestIds.length === 0) return linked;
  const links = await trx
    .selectFrom("request_works")
    .select(["request_id", "work_id"])
    .where("request_id", "in", requestIds)
    .execute();
  const workIds = [...new Set(links.map((l) => l.work_id))].sort();
  if (workIds.length === 0) return linked;
  const rows = await trx
    .selectFrom("works")
    .select(["id", "ao3_work_id", "status", "hidden_cause"])
    .where("id", "in", workIds)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const works = new Map<string, LockedWork>();
  for (const w of rows) {
    works.set(w.id, {
      id: w.id,
      ao3WorkId: w.ao3_work_id,
      status: w.status,
      hiddenCause: w.hidden_cause,
    });
  }
  for (const link of links) {
    const work = works.get(link.work_id);
    if (work) linked.set(link.request_id, [...(linked.get(link.request_id) ?? []), work]);
  }
  return linked;
}

/** Another request's active opt-out names one of the work's authors. */
async function coveredByOptOut(trx: Kysely<Database>, workId: string, requestId: string) {
  const authors = await trx
    .selectFrom("work_authors")
    .select("pseud")
    .where("work_id", "=", workId)
    .execute();
  const norms = [...new Set(authors.map((a) => normalizePseud(a.pseud)))];
  if (norms.length === 0) return false;
  const covering = await trx
    .selectFrom("optouts")
    .select("id")
    .where("active", "=", true)
    .where("request_id", "<>", requestId)
    .where("pseud_norm", "in", norms)
    .executeTakeFirst();
  return covering !== undefined;
}

/**
 * Brings back the works one request hid that are still hidden for a removal request and
 * that nothing else covers. `works` are the request's locked works; `done` holds the works
 * an earlier request of the same action already brought back, and grows. Logs nothing for
 * the request: the caller logs its reject with these works in its note. With `actor` it
 * logs a `restore` per work instead (for a request that was already decided). Returns the
 * works it restored and how many others stayed hidden because something else covers them.
 */
export async function restoreOwnWorks(
  trx: Kysely<Database>,
  requestId: string,
  works: LockedWork[],
  done: Set<string>,
  actor?: string,
) {
  const restored: LockedWork[] = [];
  const covered: string[] = [];
  const candidates = works
    .filter((w) => w.status === "hidden" && w.hiddenCause === "removal_request" && !done.has(w.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const work of candidates) {
    if (await coveredByOptOut(trx, work.id, requestId)) {
      covered.push(work.id);
      continue;
    }
    const lifted = await restoreWork(trx, work.id, {
      cause: "removal_request",
      noPendingRequests: true,
      actor,
    });
    if (lifted) {
      restored.push(work);
      done.add(work.id);
    } else covered.push(work.id);
  }
  return { restored, covered };
}

/**
 * A log note naming the restored works by AO3 work ID, cut to fit; undefined when there is
 * nothing to say. `prefix` says why, such as "Opt-out reversed. ", and counts toward the limit.
 */
export function restoredNote(restored: LockedWork[], prefix = "") {
  if (restored.length === 0) return prefix === "" ? undefined : prefix.trim();
  const ids = restored.map((w) => w.ao3WorkId).sort((a, b) => a - b);
  let note = `${prefix}Restored works:`;
  let shown = 0;
  for (const id of ids) {
    const next = `${note}${shown === 0 ? " " : ", "}${id}`;
    const more = ids.length - shown - 1;
    // Keep room for the tail that says how many are not named.
    if (next.length + (more > 0 ? ` and ${more} more`.length : 0) > NOTE_MAX) break;
    note = next;
    shown++;
  }
  return shown < ids.length ? `${note} and ${ids.length - shown} more` : note;
}

/** Restores the works of this request and of every related `remove_work` request, and rejects those still pending. */
adminRequestActions.post("/requests/:id{[A-Za-z0-9_-]+}/restore-related", async (c) => {
  const id = c.req.param("id");
  const self = `/admin/requests/${encodeURIComponent(id)}`;
  const request = await c.var.db
    .selectFrom("requests")
    .select(["id", "kind", "contact_email", "ip_hash"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!request) return c.notFound();
  // Inside the transaction only `trx` is used: `c.var.db` has one connection, which it holds.
  const outcome = await c.var.db.transaction().execute(async (trx) => {
    const related = await relatedRequests(trx, {
      id,
      contactEmail: request.contact_email,
      ipHash: request.ip_hash,
    })
      .select("requests.id")
      .where("requests.kind", "=", "remove_work")
      .execute();
    const batch = [
      ...(request.kind === "remove_work" ? [id] : []),
      ...related.map((r) => r.id),
    ].sort();
    if (batch.length === 0) return { restored: 0, covered: 0, rejected: 0 };
    // The batch's own rows first, in id order, so overlapping actions queue up here, also
    // for requests that hid no work and so have no work to lock.
    await trx
      .selectFrom("requests")
      .select("id")
      .where("id", "in", batch)
      .orderBy("id")
      .forUpdate()
      .execute();
    const linked = await lockLinkedWorks(trx, batch);
    // The pending ones are rejected first, all of them, so none counts as covering a work
    // that another of them hid.
    const rejected = await trx
      .updateTable("requests")
      .set({ status: "rejected" })
      .where("id", "in", batch)
      .where("status", "=", "pending")
      .returning("id")
      .execute();
    const wasPending = new Set(rejected.map((r) => r.id));
    const done = new Set<string>();
    const covered = new Set<string>();
    for (const requestId of batch) {
      const pending = wasPending.has(requestId);
      const result = await restoreOwnWorks(
        trx,
        requestId,
        linked.get(requestId) ?? [],
        done,
        pending ? undefined : c.var.userId,
      );
      for (const workId of result.covered) covered.add(workId);
      if (pending) {
        await logModerationAction(trx, {
          moderatorId: c.var.userId,
          action: "reject",
          targetKind: "request",
          targetId: requestId,
          note: restoredNote(result.restored, `Bulk restore from ${id.slice(0, 40)}. `),
        });
      }
    }
    const stuck = [...covered].filter((workId) => !done.has(workId)).length;
    return { restored: done.size, covered: stuck, rejected: wasPending.size };
  });
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    `${plural(outcome.restored, "work is", "works are")} live again.`,
    `${plural(outcome.rejected, "pending request was", "pending requests were")} rejected.`,
  ];
  if (outcome.covered > 0) {
    parts.push(
      `${plural(outcome.covered, "work stays", "works stay")} hidden: something else still covers ${outcome.covered === 1 ? "it" : "them"}.`,
    );
  }
  return c.html(resultPage(parts.join(" "), self));
});

/**
 * Blocks the request's requester: one `requester_blocks` row with the request's contact email
 * and IP hash, so their later requests only queue and reports from their accounts do not count
 * (X6, #67). A request with no address (the `unknown` marker) blocks the email only, as a
 * block on the marker would block every such request. A block the same already exists for logs
 * nothing, like any action that changes nothing. The log has no note: a note never holds an email.
 */
adminRequestActions.post("/requests/:id{[A-Za-z0-9_-]+}/block", async (c) => {
  const id = c.req.param("id");
  const self = `/admin/requests/${encodeURIComponent(id)}`;
  const unknownIpHash = await ipHash(c.env.IP_HASH_KEY, null);
  // Inside the transaction only `trx` is used: `c.var.db` has one connection, which it holds.
  const blocked = await c.var.db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom("requests")
      .select(["contact_email", "ip_hash"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!request) return null;
    const ip = request.ip_hash === unknownIpHash ? null : request.ip_hash;
    const email = request.contact_email.toLowerCase();
    // One block at a time per email, so two moderators blocking the same requester insert one.
    await sql`select pg_advisory_xact_lock(hashtext(${"requester_block:" + email}))`.execute(trx);
    const same = await trx
      .selectFrom("requester_blocks")
      .select("id")
      .where(sql<string>`lower(contact_email)`, "=", email)
      .where((eb) => (ip === null ? eb("ip_hash", "is", null) : eb("ip_hash", "=", ip)))
      .limit(1)
      .executeTakeFirst();
    if (same) return false;
    await trx
      .insertInto("requester_blocks")
      .values({ contact_email: request.contact_email, ip_hash: ip, created_by: c.var.userId })
      .execute();
    await logModerationAction(trx, {
      moderatorId: c.var.userId,
      action: "block",
      targetKind: "request",
      targetId: id,
    });
    return true;
  });
  if (blocked === null) return c.notFound();
  return c.html(
    resultPage(
      blocked
        ? "Requester blocked. Their later requests are stored and queued but hide nothing."
        : "This requester is blocked already: nothing changed.",
      self,
    ),
  );
});
