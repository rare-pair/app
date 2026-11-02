// Purging a removed work from Cloudflare's cache in every data centre (ARCHITECTURE,
// "Removal really removes"), through the zone's purge_cache API: the Cache API's own
// `delete` clears one data centre only.
// https://developers.cloudflare.com/api/resources/cache/methods/purge/
import { CONTENT_HOST, originalUrl } from "./content-host";
import { workCacheTag } from "./edge-cache";

/** The most URLs one purge-by-URL request takes below Enterprise. */
const MAX_FILES = 100;
/** A Cloudflare zone id: 32 lowercase hex digits. */
const ZONE_ID = /^[0-9a-f]{32}$/;
/** CLOUDFLARE_ZONE_ID's value in wrangler.jsonc, until the operator deploys the real one. */
const ZONE_PLACEHOLDER = "0".repeat(32);

/** The purge token and the zone it purges: CLOUDFLARE_PURGE_TOKEN and CLOUDFLARE_ZONE_ID. */
export interface PurgeCredentials {
  token: string;
  zoneId: string;
}

/** What to purge: the work's AO3 ID and every upload it has had. */
export interface PurgeTarget {
  ao3WorkId: number;
  uploadIds: string[];
}

export interface PurgeOptions {
  /** The Worker's `fetch` when left out; a test passes its own. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** How long to wait for each request before calling it failed. 5 seconds when left out. */
  timeoutMs?: number;
}

/**
 * Asks Cloudflare to purge every cached copy of the work: its web pages and fragments
 * by tag, its images by prefix, and its original downloads by URL. The API takes one
 * kind per request, so that is three requests.
 */
export async function purgeWorkCaches(
  credentials: PurgeCredentials,
  target: PurgeTarget,
  options: PurgeOptions = {},
): Promise<void> {
  // A Worker deployed or run without them fails here, loudly, rather than skip the purge.
  // An unset secret arrives as undefined, whatever its type says, so the test is falsiness.
  if (!credentials.token) throw new PurgeError("cache purge failed: no purge token");
  if (!ZONE_ID.test(credentials.zoneId) || credentials.zoneId === ZONE_PLACEHOLDER) {
    throw new PurgeError("cache purge failed: no zone id");
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${credentials.zoneId}/purge_cache`;
  // Both forms of each download URL until #119 settles the key: ingest stores
  // originals/<id>.epub, and the work page links originals/<id>.
  const files = target.uploadIds.flatMap((id) => [`${originalUrl(id)}.epub`, originalUrl(id)]);
  const requests: { step: string; body: PurgeBody }[] = [
    { step: "tags", body: { tags: [workCacheTag(target.ao3WorkId)] } },
    // No scheme, as the API wants, and the trailing slash keeps works/12/ from matching works/123/.
    { step: "prefixes", body: { prefixes: [`${CONTENT_HOST}/works/${target.ao3WorkId}/img/`] } },
  ];
  for (let i = 0; i < files.length; i += MAX_FILES) {
    requests.push({ step: "files", body: { files: files.slice(i, i + MAX_FILES) } });
  }
  // All at once, and each to the end, so one failing doesn't leave the others unasked.
  const failed = await Promise.all(
    requests.map(async ({ step, body }) => {
      const why = await request(url, credentials.token, body, options);
      return why === null ? null : `${step} (${why})`;
    }),
  );
  const failures = failed.filter((f) => f !== null);
  if (failures.length > 0) throw new PurgeError(`cache purge failed: ${failures.join(", ")}`);
}

/**
 * Thrown when Cloudflare didn't accept every purge request. Its message names the
 * requests that failed, with the HTTP status or Cloudflare's numeric error codes,
 * and never the token, the zone or the reply's text.
 */
export class PurgeError extends Error {
  override name = "PurgeError";
}

/** One purge request's body: the API takes one kind of purge per request. */
type PurgeBody = { tags: string[] } | { prefixes: string[] } | { files: string[] };

/** Sends one purge request: null when Cloudflare accepted it, or why not. */
async function request(
  url: string,
  token: string,
  body: PurgeBody,
  options: PurgeOptions,
): Promise<string | null> {
  try {
    const res = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // The API never redirects; following one would carry the token wherever it points.
      // A 3xx comes back as itself, not ok, so it counts as a failure. (workerd has no "error".)
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      // Unread, its body would hold the connection until garbage collection.
      await res.body?.cancel();
      return `HTTP ${res.status}`;
    }
    // `success: true` means accepted; anything else, a 200 included, is a failure.
    const reply: { success?: boolean; errors?: { code?: number }[] } | null = await res.json();
    if (reply?.success === true) return null;
    const codes = (Array.isArray(reply?.errors) ? reply.errors : []).flatMap((e) =>
      Number.isInteger(e.code) ? [e.code] : [],
    );
    return codes.length > 0 ? `codes ${codes.join(" ")}` : "not accepted";
  } catch (error) {
    // Unreachable, too slow, or an answer that isn't the JSON Cloudflare sends.
    return error instanceof Error ? error.name : "no reply";
  }
}
