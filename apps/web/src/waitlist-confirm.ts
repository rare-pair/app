import { createDb } from "@archive/db";
import type { Context } from "hono";
import { sql } from "kysely";
import type { Bindings } from "./env";
import { readForm } from "./login";
import type { SecurityVariables } from "./security";
import { isSameOrigin } from "./signin";
import { isPrelaunch } from "./prelaunch";
import { hashToken } from "./waitlist";
import {
  waitlistArchiveOpenPage,
  waitlistConfirmedPage,
  waitlistConfirmPage,
  waitlistForbiddenPage,
  waitlistLinkRefusedPage,
} from "./waitlist-pages";

// The tokens we issue are 43 base64url characters (waitlist.ts newToken). Anything
// longer or of another alphabet was never issued, and isn't put back into a page or
// looked up.
const ISSUED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

type ConfirmContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

// The token is in the URL: keep it out of caches, and let a Referer carry only the
// origin. Not no-referrer: under it the browser sends the page's own POST with
// `Origin: null`, which isSameOrigin refuses (see confirm.ts).
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin" };

const refused = (c: ConfirmContext) => c.html(waitlistLinkRefusedPage(), 400, NO_STORE);

const isIssuable = (token: string) => ISSUED_TOKEN.test(token);

// After launch the list is closed, and soon purged: an old link confirms nothing, and no
// lookup is made, so a valid token can not confirm either.
const archiveOpen = (c: ConfirmContext) => c.html(waitlistArchiveOpenPage(), 200, NO_STORE);

/**
 * `GET /waitlist/confirm`: the emailed link. It shows a button and reads nothing from
 * the database, so a mail scanner opening it changes nothing.
 */
export function showWaitlistConfirm(c: ConfirmContext) {
  if (!isPrelaunch(c.env)) return archiveOpen(c);
  const token = c.req.query("token") ?? "";
  if (!isIssuable(token)) return refused(c);
  return c.html(waitlistConfirmPage(token), 200, NO_STORE);
}

/**
 * `POST /waitlist/confirm`: confirms the address. One statement does it all: it sets
 * `confirmed_at` and clears the hash only where the hash matches, the row is
 * unconfirmed and its email is under 7 days old. A second request with the same token
 * waits on the row lock, finds the hash gone and matches nothing, so it gets the
 * refused page. Never a select then an update.
 */
export async function confirmWaitlist(c: ConfirmContext) {
  if (!isPrelaunch(c.env)) return archiveOpen(c);
  if (!isSameOrigin(c.req.raw.headers)) return c.html(waitlistForbiddenPage(), 403);

  const form = (await readForm(c.req.raw)) ?? new URLSearchParams();
  const token = form.get("token") ?? "";
  if (!isIssuable(token)) return refused(c);

  const hash = await hashToken(token);
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    const confirmed = await db
      .updateTable("waitlist")
      .set({ confirmed_at: sql<Date>`now()`, confirm_token_hash: null })
      .where("confirm_token_hash", "=", hash)
      .where("confirmed_at", "is", null)
      .where("confirm_sent_at", ">", sql<Date>`now() - interval '7 days'`)
      .returning("email")
      .executeTakeFirst();
    return confirmed === undefined ? refused(c) : c.html(waitlistConfirmedPage(), 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
