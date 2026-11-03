// The emailed confirmation of a removal request or opt-out, `/remove/confirm` (ARCHITECTURE,
// Author requests & takedowns). A request is stored unconfirmed by `POST /remove` (remove.ts)
// and hides nothing; opening its link shows a button, and pressing it confirms the request
// and does what the request asks, in one transaction: hides the work, or adds the active
// opt-out and hides every live work by the pseud, and writes the `request_works` rows.
// Everything that changes anything is in `confirmRequest`, so blocking a requester (X6, #67)
// has one place to condition it: a blocked requester's request is confirmed and stored but
// does nothing until a moderator approves it (admin-items.ts `confirmOptOut`). Nothing here logs.

import { createDb, hideWork, isRequesterBlocked, normalizePseud } from "@archive/db";
import type { Context } from "hono";
import { sql } from "kysely";
import type { Bindings } from "./env";
import { ipHash } from "./ip-hash";
import { readForm } from "./login";
import { removeConfirmedPage, requestConfirmPage, removeLinkRefusedPage } from "./remove-pages";
import type { SecurityVariables } from "./security";
import { hashToken } from "./waitlist";

type ConfirmContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;
type Trx = Parameters<typeof hideWork>[0];

// The tokens we issue are 43 base64url characters (waitlist.ts newToken). Anything longer
// or of another alphabet was never issued, and isn't put back into a page or looked up.
const ISSUED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

// The token is in the URL: keep it out of caches, and let a Referer carry only the origin.
// Not no-referrer: under it the browser sends the page's own POST with `Origin: null`, which
// `sameOriginOnly` refuses (see confirm.ts).
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin" };

const refused = (c: ConfirmContext) => c.html(removeLinkRefusedPage(), 400, NO_STORE);

/**
 * Hides a work for a stored request, and links it to the request only when this hide changed
 * it: `hideWork` touches a live work only, so one hidden or removed already is left as it is
 * and gets no link.
 */
async function hideForRequest(trx: Trx, requestId: string, id: string) {
  if (await hideWork(trx, id, "removal_request")) {
    await trx.insertInto("request_works").values({ request_id: requestId, work_id: id }).execute();
  }
}

/**
 * The opt-out a request asks for, in `trx`: the active `optouts` row, and every live work by
 * the pseud hidden for the request, with its `request_works` link. Used when a requester
 * confirms, and when a moderator approves the opt-out of a blocked requester. The caller
 * has locked the request's row.
 */
export async function applyOptOut(trx: Trx, request: { id: string; pseud_norm: string }) {
  await trx
    .insertInto("optouts")
    .values({ pseud_norm: request.pseud_norm, request_id: request.id, active: true })
    .execute();
  // A stored pseud is as written, so it is matched here by the rule the opt-out list uses, not
  // in SQL. This reads every author row: it grows with the archive.
  const authors = await trx.selectFrom("work_authors").select(["work_id", "pseud"]).execute();
  const matching = new Set<string>();
  for (const author of authors) {
    if (normalizePseud(author.pseud) === request.pseud_norm) matching.add(author.work_id);
  }
  // In id order, so two overlapping requests lock the same works in the same order.
  for (const matched of [...matching].sort()) await hideForRequest(trx, request.id, matched);
}

/**
 * Confirms the request the token belongs to, and carries it out, in `trx`. Returns false, with
 * nothing written, when the token matches no request that can still be confirmed: the claim
 * is one UPDATE that sets `confirmed_at` and clears the hash only where the hash matches, the
 * request is unconfirmed and still pending (a moderator's reject kills its link) and its
 * email is under 7 days old. A second press with the same token waits on the row lock, finds
 * the hash gone and matches nothing. Never a select then an update.
 *
 * The request's row is locked, then its work's, then the claim: requests before works, as a
 * moderator's reject and the bulk restore lock them (admin-items.ts, admin-request-actions.ts),
 * so none waits on another in the opposite order; and so a reject's check for another request
 * still waiting reads this one once it commits. An opt-out's matching works are locked as the
 * hides reach them, in id order, after its request row.
 *
 * A request from a blocked requester (X6, #67: a block names the contact email or the IP hash,
 * checked now, so a request made before the block and confirmed after it is blocked too) is
 * claimed like any other, so the link is spent and the page is the same, but it hides nothing
 * and writes no opt-out: it waits in the moderators' queue. `unknownIpHash` is the stored hash
 * of a request with no address, which never counts as a match.
 */
export async function confirmRequest(
  trx: Trx,
  hash: string,
  unknownIpHash: string,
): Promise<boolean> {
  // The row the token names, locked first, and its work after it: the order a moderator's
  // reject and the bulk restore take (requests, then works; admin-request-actions.ts). The
  // claim below still decides; a row that isn't there, or is decided meanwhile, matches
  // nothing in it.
  const named = await trx
    .selectFrom("requests")
    .select("work_id")
    .where("confirm_token_hash", "=", hash)
    .forUpdate()
    .executeTakeFirst();
  if (named?.work_id) {
    await trx
      .selectFrom("works")
      .select("id")
      .where("id", "=", named.work_id)
      .forNoKeyUpdate()
      .execute();
  }
  const claimed = await trx
    .updateTable("requests")
    .set({ confirmed_at: sql<Date>`now()`, confirm_token_hash: null })
    .where("confirm_token_hash", "=", hash)
    .where("confirmed_at", "is", null)
    .where("status", "=", "pending")
    .where("confirm_sent_at", ">", sql<Date>`now() - interval '7 days'`)
    .returning(["id", "kind", "work_id", "pseud_norm", "contact_email", "ip_hash"])
    .executeTakeFirst();
  if (claimed === undefined) return false;
  const blocked = await isRequesterBlocked(trx, {
    email: claimed.contact_email,
    ipHash: claimed.ip_hash === unknownIpHash ? null : claimed.ip_hash,
  });
  if (blocked) return true;

  if (claimed.kind === "remove_work") {
    if (claimed.work_id !== null) await hideForRequest(trx, claimed.id, claimed.work_id);
    return true;
  }
  if (claimed.pseud_norm === null) return true;
  await applyOptOut(trx, { id: claimed.id, pseud_norm: claimed.pseud_norm });
  return true;
}

/**
 * `GET /remove/confirm`: the emailed link. It shows a button and reads nothing from the
 * database, so a mail scanner opening it changes nothing.
 */
export function showRemoveConfirm(c: ConfirmContext) {
  const token = c.req.query("token") ?? "";
  if (!ISSUED_TOKEN.test(token)) return refused(c);
  return c.html(requestConfirmPage(token), 200, NO_STORE);
}

/**
 * `POST /remove/confirm`, behind `sameOriginOnly` (index.ts): confirms the request. A
 * refused token (used, expired, unknown or never issued) gets one page. The answer is the same
 * whatever the work's status.
 */
export async function confirmRemove(c: ConfirmContext) {
  const form = (await readForm(c.req.raw)) ?? new URLSearchParams();
  const token = form.get("token") ?? "";
  if (!ISSUED_TOKEN.test(token)) return refused(c);

  const hash = await hashToken(token);
  // Its queries run one after another inside one transaction, so one connection.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  const unknownIpHash = await ipHash(c.env.IP_HASH_KEY, null);
  try {
    const confirmed = await db
      .transaction()
      .execute((trx) => confirmRequest(trx, hash, unknownIpHash));
    return confirmed ? c.html(removeConfirmedPage(), 200, NO_STORE) : refused(c);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
