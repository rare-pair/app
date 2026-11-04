import { createDb } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import type { SecurityVariables } from "./security";
import { hashToken } from "./waitlist";
import {
  waitlistUnsubscribedPage,
  waitlistUnsubscribePage,
  waitlistUnsubscribeRefusedPage,
} from "./waitlist-pages";

// The tokens we issue are 43 base64url characters (waitlist.ts newToken). Anything
// longer or of another alphabet was never issued, and isn't put back into a page or
// hashed.
const ISSUED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

type UnsubscribeContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

// The token is in the URL: keep it out of caches, and let a Referer carry only the origin.
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin" };

const refused = (c: UnsubscribeContext) => c.html(waitlistUnsubscribeRefusedPage(), 400, NO_STORE);

/**
 * `GET /waitlist/unsubscribe`: the link in the launch email. It shows a button and reads
 * nothing from the database, so a mail scanner opening it unsubscribes no one.
 */
export function showWaitlistUnsubscribe(c: UnsubscribeContext) {
  const token = c.req.query("token") ?? "";
  if (!ISSUED_TOKEN.test(token)) return refused(c);
  return c.html(waitlistUnsubscribePage(token), 200, NO_STORE);
}

/**
 * `POST /waitlist/unsubscribe`: deletes the row. The token is the only secret, and it is
 * read from the URL alone, because a mail provider's one-click request (RFC 8058) posts
 * to the exact URL in the `List-Unsubscribe` header, with a fixed body that is ignored.
 * There is deliberately no Origin check (mail providers send none; ARCHITECTURE, Wait
 * list), no need for a cookie and no redirect. One statement deletes by hash; a token with no row
 * (already used, purged, never issued) gets the same 200, so the answer says nothing
 * about who is on the list.
 */
export async function unsubscribeWaitlist(c: UnsubscribeContext) {
  const token = c.req.query("token") ?? "";
  if (!ISSUED_TOKEN.test(token)) return refused(c);

  const hash = await hashToken(token);
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    await db.deleteFrom("waitlist").where("unsubscribe_token_hash", "=", hash).execute();
    return c.html(waitlistUnsubscribedPage(), 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
