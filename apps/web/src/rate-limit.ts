// The Workers rate-limiting binding's side of the surge controls (ARCHITECTURE, Surge
// controls), shared by every limited route: sign-in now, then uploads, search, removal
// requests and the wait list. Each route passes its own binding and key.

import { tooManyRequestsPage } from "./pages";

/** The sign-in limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const LOGIN_WINDOW_SECONDS = 60;

/** The wait list limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const WAITLIST_WINDOW_SECONDS = 60;

/** The notice form's limit window, as wrangler.jsonc sets it: the binding doesn't say. */
export const DMCA_WINDOW_SECONDS = 60;

/** The removal form's limits' window, as wrangler.jsonc sets it: the binding doesn't say. */
export const REMOVE_WINDOW_SECONDS = 60;

/**
 * A limiter key: a hex SHA-256 of the value under its prefix, so the limiter is never handed
 * the address itself. Unkeyed, so not a secret: an IPv4 key can be reversed by trying every
 * address. Fine while keys are never stored or logged.
 */
async function hashKey(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prefix + value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A dotted IPv4 address, each octet 0 to 255 in decimal without leading zeros.
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/**
 * An IPv6 address's eight groups, a dotted IPv4 tail counting as the two it stands for,
 * or null when it isn't an IPv6 address.
 */
function ipv6Groups(address: string): string[] | null {
  let text = address.toLowerCase();
  const at = text.lastIndexOf(":") + 1;
  const last = text.slice(at);
  if (last.includes(".")) {
    if (!IPV4.test(last)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = last.split(".").map(Number);
    text = `${text.slice(0, at)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half = "") => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  // A "::" stands for one group of zeros or more; without one there must be eight.
  const zeros = 8 - head.length - tail.length;
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return null;
  const all = [...head, ...Array<string>(zeros).fill("0"), ...tail];
  return all.every((group) => HEX_GROUP.test(group)) ? all : null;
}

/**
 * Who a client address stands for: an IPv4 address whole, and an IPv6 one by its /64, which
 * one subscriber commonly holds all of, written out in full however it was shortened. An
 * IPv4 address written as IPv6 (`::ffff:198.51.100.7`, or `::ffff:c633:6407`) is that IPv4
 * address. Anything that isn't an address stands for itself, so it never shares a real
 * address's count.
 */
export function clientOf(address: string): string {
  if (IPV4.test(address)) return address;
  const groups = ipv6Groups(address);
  if (groups === null) return `not an address: ${address}`;
  const [high = 0, low = 0] = groups.slice(6).map((group) => Number.parseInt(group, 16));
  const mapped = groups.slice(0, 5).every((group) => Number.parseInt(group, 16) === 0);
  if (mapped && groups[5] === "ffff") return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

/**
 * A limit's key for a client, from its `cf-connecting-ip` (which Cloudflare sets), or null
 * when the request has none. Requests without one, or with it empty, share a key, so they
 * are limited too. `scope` names the limit ("login"), so two limits' keys never collide even
 * where they share a namespace.
 */
export const ipKey = (scope: string, address: string | null) =>
  hashKey(`${scope}-ip:`, address === null || address === "" ? "unknown" : clientOf(address));

/** A limit's key for an email address, however it was spelt: trimmed and lowercased. */
export const emailKey = (scope: string, address: string) =>
  hashKey(`${scope}-email:`, address.trim().toLowerCase());

/**
 * Whether `key` is over its limit in the current window. When the binding fails the request
 * goes through: the binding's counts are approximate and only meant to slow abuse
 * (ARCHITECTURE, Surge controls), so its outage mustn't take a route down with it. Only the error's name is logged, since the
 * message could carry the key. A binding missing from the config is a mistake, not an
 * outage, so it throws rather than quietly turning the limit off.
 */
export async function isLimited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (limiter === undefined) throw new Error("Rate limit binding missing");
  try {
    return !(await limiter.limit({ key })).success;
  } catch (error) {
    console.error(`Rate limit unavailable: ${error instanceof Error ? error.name : "Error"}`);
    return false;
  }
}

/**
 * The 429 for a limited request: the plain page and `Retry-After`, both saying the same
 * whole number of seconds, rounded up and at least one.
 */
export function tooManyRequests(seconds: number): Response {
  const wait = Math.max(1, Math.ceil(seconds));
  return new Response(tooManyRequestsPage(wait), {
    status: 429,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Retry-After": String(wait),
      "Cache-Control": "no-store",
    },
  });
}
