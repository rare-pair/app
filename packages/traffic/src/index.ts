// Who a request comes from, for every Worker: over `Headers` and Web Crypto, and pure but for the
// limiter check (limited.ts), so it runs in workerd and in Node, and with no dependency, because a
// Worker can't reach another's src.

import { CRAWLER_LIST } from "./crawler-list";

export { clientOf, hashKey, ipKey } from "./client-key";
export { isLimited } from "./limited";

/** Why a request declares itself automated. Each is also how a refusal's log line names it. */
export type DeclaredReason = "signature" | "crawler list";

/** Why a request declares itself automated, or null when it doesn't. */
export function declaredClient(headers: Headers): DeclaredReason | null {
  // Its presence is the announcement, so the value, empty or not, is never read.
  if (headers.has("signature-agent")) return "signature";
  const userAgent = headers.get("user-agent")?.toLowerCase() ?? "";
  return CRAWLER_LIST.some((name) => userAgent.includes(name)) ? "crawler list" : null;
}

/**
 * Whether a browser is fetching this for another site's page: as an image, a frame or a script's
 * request. A link the reader follows is `document`. A request with no `Sec-Fetch-Dest` isn't one:
 * browsers that send these headers send both. Each Worker decides which paths this guards.
 */
export function isCrossSiteSubresource(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  return headers.get("sec-fetch-site") === "cross-site" && dest !== null && dest !== "document";
}
