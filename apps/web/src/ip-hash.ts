// The one form of a requester's network address that is stored (`requests.ip_hash`, and
// later the blocks that match it): HMAC-SHA-256 under the IP_HASH_KEY secret, so a stored
// value can't be reversed by trying every IPv4 address without the key. Every form that
// stores or matches an address goes through this, so the values stay comparable. Changing
// the key or the grouping orphans every stored value.

import { clientOf } from "./rate-limit";

// What a request with no `cf-connecting-ip` stands for. `clientOf` never returns it: a text
// that isn't an address comes back prefixed, so no sent address collides with it.
const UNKNOWN = "unknown";

/**
 * Lowercase hex HMAC-SHA-256 of who `address` stands for: an IPv4 address whole, an IPv6
 * one by its /64, an IPv4 address written as IPv6 as that IPv4 address (`clientOf`). A
 * missing or empty address is one fixed marker, so the column is never blank.
 */
export async function ipHash(key: string, address: string | null): Promise<string> {
  return hmacHex(key, address === null || address === "" ? UNKNOWN : clientOf(address));
}

/**
 * The form of an email address the daily sign-in count stores: the same HMAC, of the address
 * trimmed and lowercased as the limits' keys are, no more merged than that. The prefix keeps it
 * apart from anything `ipHash` makes. Changing the key only starts the day's counts again.
 */
export function signInEmailHash(key: string, address: string): Promise<string> {
  return hmacHex(key, `sign-in-email:${address.trim().toLowerCase()}`);
}

async function hmacHex(key: string, text: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
