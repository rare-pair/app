import { createHash, randomBytes } from "node:crypto";
import { SITE, type Site } from "./site";

/**
 * Waits up to 10 seconds for the `nth` (the newest by default) confirmation email to `email`,
 * and returns its link. With `nth` the wait is for that many to have arrived.
 */
export async function waitlistLink(site: Site, email: string, nth?: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const sent = (await site.emails()).filter(
      (m) => m.kind === "waitlist-confirm" && m.to === email,
    );
    const found = nth === undefined ? sent.at(-1) : sent[nth - 1];
    if (found !== undefined) return found.url;
    if (Date.now() > deadline) throw new Error(`no wait list email to ${email} in 10 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** How many confirmation emails have been queued to `email`. */
export async function waitlistEmailCount(site: Site, email: string): Promise<number> {
  return (await site.emails()).filter((m) => m.kind === "waitlist-confirm" && m.to === email)
    .length;
}

/**
 * Seeds an address the launch email has gone to, and returns its unsubscribe link. The launch
 * email itself goes on a queue the harness has no sink for, so it isn't sent: the link is built
 * the way the launch script does, a random token held as its SHA-256 hex.
 */
export async function seedLaunched(site: Site, email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await site.db
    .insertInto("waitlist")
    .values({
      email,
      confirm_token_hash: null,
      confirmed_at: now,
      notified_at: now,
      unsubscribe_token_hash: createHash("sha256").update(token).digest("hex"),
    })
    .execute();
  return `${SITE}/waitlist/unsubscribe?token=${token}`;
}
