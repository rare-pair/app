import { createDb, type Database } from "@archive/db";
import type { Context } from "hono";
import { sql, type Kysely } from "kysely";
// The mailer's own rule, so an address is accepted only if the mailer would send to it.
// Pure and dependency-free: this is all of apps/mailer the Worker bundles.
import { isSendableAddress } from "../../mailer/src/message";
import type { Bindings } from "./env";
import { floorOf, padTo } from "./floor";
import { MAX_EMAIL, NO_STORE, readForm } from "./login";
import { isPrelaunch } from "./prelaunch";
import { emailKey, ipKey, isLimited, tooManyRequests, WAITLIST_WINDOW_SECONDS } from "./rate-limit";
import type { SecurityVariables } from "./security";
import { isSameOrigin, SITE } from "./signin";
import { TURNSTILE_ACTIONS, verifyTurnstile } from "./turnstile";
import {
  comingSoonPage,
  waitlistCheckEmailPage,
  waitlistForbiddenPage,
  waitlistUnavailablePage,
} from "./waitlist-pages";

type WaitlistContext = Context<{ Bindings: Bindings; Variables: SecurityVariables }>;

// ARCHITECTURE, Wait list: an unconfirmed address gets at most one confirmation email
// an hour, and 3 in all.
const MAX_CONFIRMATIONS = 3;

/** A new confirmation token: 32 random bytes, base64url, so it goes in a link as it is. */
export const newToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/**
 * Lowercase hex SHA-256 of a token: what the table keeps instead of it. The confirm route
 * looks a row up by this.
 */
export const hashToken = async (token: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * Writes the address's new token hash, if it is owed a confirmation email, and returns how
 * to undo the write, or null when no email is owed. A new address gets a row. An address
 * on the list gets a new token only while unconfirmed, more than an hour after its last
 * email and with fewer than 3 sent. Each is one statement, so two joins at once can't
 * both write: the second finds the row, or finds its last email just sent.
 */
async function claimConfirmation(
  db: Kysely<Database>,
  email: string,
  hash: string,
): Promise<(() => Promise<void>) | null> {
  const inserted = await db
    .insertInto("waitlist")
    .values({ email, confirm_token_hash: hash })
    .onConflict((oc) => oc.column("email").doNothing())
    .returning("email")
    .executeTakeFirst();
  if (inserted !== undefined) {
    return async () => {
      await db
        .deleteFrom("waitlist")
        .where("email", "=", email)
        .where("confirm_token_hash", "=", hash)
        .execute();
    };
  }

  // Joined to itself to return the values it replaces, so they can be put back.
  const previous = await db
    .updateTable("waitlist as w")
    .from("waitlist as old")
    .set((eb) => ({
      confirm_token_hash: hash,
      confirm_sent_at: sql<Date>`now()`,
      confirm_count: eb("w.confirm_count", "+", 1),
    }))
    .whereRef("old.email", "=", "w.email")
    .where("w.email", "=", email)
    .where("w.confirmed_at", "is", null)
    .where("w.confirm_count", "<", MAX_CONFIRMATIONS)
    .where("w.confirm_sent_at", "<", sql<Date>`now() - interval '1 hour'`)
    .returning((eb) => [
      "old.confirm_token_hash as hash",
      // As text: a Date would drop the microseconds Postgres keeps.
      eb.cast<string>("old.confirm_sent_at", "text").as("sentAt"),
      "old.confirm_count as count",
    ])
    .executeTakeFirst();
  if (previous === undefined) return null;
  // Only while the token is still this request's: never over a later one.
  return async () => {
    await db
      .updateTable("waitlist")
      .set({
        confirm_token_hash: previous.hash,
        confirm_sent_at: sql<Date>`${previous.sentAt}::timestamptz`,
        confirm_count: previous.count,
      })
      .where("email", "=", email)
      .where("confirm_token_hash", "=", hash)
      .execute();
  };
}

/**
 * `POST /waitlist`, before launch: queues one confirmation email (ARCHITECTURE, Wait list).
 * Every answer comes after the floor (src/floor.ts), whatever happened, so how long it took
 * can't show whether an address is on the list (#216). Only the 404 once the archive is
 * open isn't held: nothing is joined then.
 */
export async function joinWaitlist(c: WaitlistContext) {
  if (!isPrelaunch(c.env)) return c.notFound();
  return padTo(floorOf(c.env.WAITLIST_FLOOR_MS), () => join(c));
}

/**
 * The checks run as `POST /login`'s do: the origin, then the IP's limit, both before the body
 * is read; then Turnstile; then the address, then its limit. The reply is the same page
 * whether or not an email went.
 */
async function join(c: WaitlistContext) {
  if (!isSameOrigin(c.req.raw.headers)) return c.html(waitlistForbiddenPage(), 403);
  // Before the body is read or Turnstile is asked, so a flood costs neither.
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  if (await isLimited(c.env.WAITLIST_IP_LIMIT, await ipKey("waitlist", clientIp))) {
    return tooManyRequests(WAITLIST_WINDOW_SECONDS);
  }

  const nonce = c.get("nonce");
  const siteKey = c.env.TURNSTILE_SITE_KEY;
  const form = await readForm(c.req.raw);
  if (form === null) {
    // Nothing of it is shown back: the form comes again empty.
    const error = "That request was too large. Please try again.";
    return c.html(comingSoonPage(nonce, siteKey, { error }), 413, NO_STORE);
  }
  const typed = form.get("email") ?? "";
  // What was typed comes back in the form, unless it's too long to be an address.
  const formAgain = (status: 400 | 503, error: string) =>
    c.html(
      comingSoonPage(nonce, siteKey, { email: typed.length > MAX_EMAIL ? "" : typed, error }),
      status,
      NO_STORE,
    );

  const turnstile = await verifyTurnstile(form.get("cf-turnstile-response"), {
    secret: c.env.TURNSTILE_SECRET_KEY,
    hostname: new URL(c.req.url).hostname,
    action: TURNSTILE_ACTIONS.waitlist,
    remoteIp: clientIp,
  });
  if (turnstile === "failed") {
    return formAgain(400, "The anti-spam check did not pass. Please try again.");
  }
  if (turnstile === "unavailable") {
    return formAgain(
      503,
      "The anti-spam check is not answering just now. Please try again in a minute.",
    );
  }

  const email = typed.trim().toLowerCase();
  if (!isSendableAddress(email)) return formAgain(400, "Enter a valid email address.");
  // Only a solved check can spend an address's limit, so nobody can use up another's.
  if (await isLimited(c.env.WAITLIST_EMAIL_LIMIT, await emailKey("waitlist", email))) {
    return tooManyRequests(WAITLIST_WINDOW_SECONDS);
  }

  const token = newToken();
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString });
  try {
    const undo = await claimConfirmation(db, email, await hashToken(token));
    if (undo !== null) {
      // No transaction is held across the send: the row is written, then put back if
      // the email can't be queued, so a retry isn't refused by the one-hour rule.
      try {
        const url = `${SITE}/waitlist/confirm?token=${token}`;
        await c.env.EMAIL.send({ kind: "waitlist-confirm", to: email, url });
      } catch (error) {
        // Its kind only: a queue error can name the address.
        const kind = error instanceof Error ? error.name : "unknown";
        console.error(`${c.req.method} ${c.req.path}: email not queued: ${kind}`);
        // If this fails too, onError answers 500: the page below would be untrue.
        await undo();
        return c.html(waitlistUnavailablePage(), 503);
      }
    }
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
  return c.html(waitlistCheckEmailPage());
}
