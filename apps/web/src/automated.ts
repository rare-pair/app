// Refusing automated clients on the app (ARCHITECTURE, Crawlers and agents; spec 24). Runs before
// the session and every route, so a refusal costs no lookup and shows nothing of any work.

import { declaredClient, isCrossSiteSubresource } from "@archive/traffic";
import type { MiddlewareHandler } from "hono";
import { automatedAccessPage } from "./pages";
import type { SecurityVariables } from "./security";

// The fic text paths on this host. `c.req.path` is the decoded form the router matches, so a
// percent-encoded spelling can't get round this or the exempt path below.
const FIC_TEXT = /^\/works\/[^/]+\/(?:chapters(?:\/[^/]+)?|full)$/;

/** Why this request is refused, or null. Written here, so a log line holds nothing it sent. */
function refusalReason(headers: Headers, method: string, path: string) {
  // Mail providers send this for one-click unsubscribe. `/robots.txt` is exempt too: its route
  // answers before this runs.
  if (method === "POST" && path === "/waitlist/unsubscribe") return null;
  return (
    declaredClient(headers) ??
    (FIC_TEXT.test(path) && isCrossSiteSubresource(headers) ? "cross-site subresource" : null)
  );
}

/** The 403 for a declared automated client, or another site's embed of fic text. */
export const refuseAutomated: MiddlewareHandler<{ Variables: SecurityVariables }> = async (
  c,
  next,
) => {
  const reason = refusalReason(c.req.raw.headers, c.req.method, c.req.path);
  if (reason === null) return next();
  // The whole line: the reason and nothing else, since a URL or address has no place in it.
  console.log(`refused: ${reason}`);
  c.set("refused", true);
  return c.html(automatedAccessPage(), 403, { "Cache-Control": "no-store" });
};
