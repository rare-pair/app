import type { Database } from "@archive/db";
import type { Kysely } from "kysely";

/**
 * What the sign-in button page shows of an address: its first character, three stars
 * whatever the local part's length, and the domain, all lowercased. Null when it isn't
 * shaped like an address.
 */
export function maskEmail(email: string): string | null {
  const lowered = email.toLowerCase();
  const at = lowered.lastIndexOf("@");
  const domain = lowered.slice(at + 1);
  if (at < 1 || domain === "") return null;
  return `${String.fromCodePoint(lowered.codePointAt(0)!)}***@${domain}`;
}

/**
 * The masked address of an unused, unexpired sign-in link, or null for any other token.
 * A plain select, on the uncached binding the caller's `db` is built from: Better Auth's
 * own read (`findVerificationValue`) deletes every expired row, and a page that scanners
 * open writes nothing. The identifier and the row's value are the magic-link plugin's
 * (better-auth 1.7.14); the tests issue a real token, so a change of either fails them.
 */
export async function maskedAddressOfLink(
  db: Kysely<Database>,
  token: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("verification")
    .select("value")
    .where("identifier", "=", `magic-link:${await hashLinkToken(token)}`)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (row === undefined) return null;
  // SAFETY: the row's value is JSON the plugin wrote. A value of any other shape throws,
  // here or in maskEmail, and the caller shows the plain page.
  const { email } = JSON.parse(row.value) as { email: string };
  return maskEmail(email);
}

/** The plugin's stored form of a token: SHA-256, as unpadded base64url. */
async function hashLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
