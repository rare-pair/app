import type { Page } from "playwright";
import { expect } from "vitest";
import { outbound } from "../../test/stand-ins";
import type { Site } from "./site";

/** A purge_cache request web made, as the stand-in for Cloudflare's API recorded it. */
export type PurgeRequest = {
  zone: string;
  /** Whether it carried the test purge token. */
  authorized: boolean;
  body: { tags?: string[]; prefixes?: string[]; files?: string[] };
};

/**
 * Every purge_cache request web has made, from every site in this process (the stand-in is
 * shared, so filter by your own work and upload ids). Real purge is deploy-only: the stand-in
 * records the request and clears nothing, so this shows what web asked Cloudflare to purge,
 * never that a zone or browser cache was cleared.
 */
export async function purgeRequests(): Promise<PurgeRequest[]> {
  const log = await outbound(new Request("https://purge-log.test/"));
  // SAFETY: the stand-in answers with the JSON array of the requests it recorded.
  return (await log.json()) as PurgeRequest[];
}

/**
 * Checks that the moderation log holds exactly one row for this action: there is no page for the
 * log, only the `moderation_actions` table. Returns the row's note, which never holds an email.
 */
export async function expectLogged(
  site: Site,
  row: { action: string; targetKind: string; targetId: string; moderatorId: string },
): Promise<string | null> {
  const rows = await site.db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "note"])
    .where("action", "=", row.action)
    .where("target_kind", "=", row.targetKind)
    .where("target_id", "=", row.targetId)
    .execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.moderator_id).toBe(row.moderatorId);
  return rows[0]?.note ?? null;
}

/**
 * A confirmation token as `/remove` emails one (43 base64url characters) and the hash the
 * `requests` table keeps for it (lowercase hex SHA-256), made here so the browser project
 * needn't import the Worker's source, which its tsconfig has no Workers types for.
 */
export async function confirmationToken(): Promise<{ token: string; hash: string }> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return { token, hash: Buffer.from(digest).toString("hex") };
}

/** A synthetic address for any account a journey signs in or seeds (a requester's, mostly). */
export const requesterEmail = (name: string) => `pw6-${name}@example.test`;

/** On a moderation queue, opens the row whose text holds `text`, such as a work's "(42300)". */
export async function openRow(page: Page, text: string): Promise<void> {
  await page.locator("tr", { hasText: text }).getByRole("link").click();
}

/** On an item's page, presses Approve and then its confirm step, which removes the work for good. */
export async function approveAndRemove(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Approve and remove work", exact: true }).click();
  await page.getByRole("button", { name: "Approve and remove work for good" }).click();
}

/**
 * Inserts a request as `/remove` stores it, a confirmed one by default (the requester pressed
 * the emailed link), and returns its id. `hid` lists works it hid (their `request_works` rows;
 * the caller seeds those works as hidden). The IP hash is a made-up marker, never a real one.
 */
export async function insertRequest(
  site: Site,
  options: {
    kind?: "remove_work" | "opt_out";
    workId?: string;
    pseudNorm?: string;
    email: string;
    ipHash?: string;
    status?: string;
    confirmed?: boolean;
    hid?: string[];
    /** SHA-256 hex of a token a test opens `/remove/confirm` with; the request is unconfirmed. */
    confirmTokenHash?: string;
  },
): Promise<string> {
  const confirmed = options.confirmed ?? options.confirmTokenHash === undefined;
  const row = await site.db
    .insertInto("requests")
    .values({
      kind: options.kind ?? "remove_work",
      work_id: options.workId ?? null,
      pseud_norm: options.pseudNorm ?? null,
      contact_email: options.email,
      statement: "A synthetic statement for a journey.",
      status: options.status ?? "pending",
      ip_hash: options.ipHash ?? `pw6-ip-${options.email}`,
      confirm_token_hash: options.confirmTokenHash ?? null,
      confirm_sent_at: confirmed ? null : new Date(),
      confirmed_at: confirmed ? new Date() : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const workId of options.hid ?? []) {
    await site.db
      .insertInto("request_works")
      .values({ request_id: row.id, work_id: workId })
      .execute();
  }
  return row.id;
}
