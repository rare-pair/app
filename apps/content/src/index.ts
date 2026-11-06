import { createDb, getImageAccess, getOriginalAccess, type ContentAccess } from "@archive/db";
import { declaredClient, isCrossSiteSubresource } from "@archive/traffic";

export interface Env {
  BUCKET: R2Bucket;
  /** The uncached config (ARCHITECTURE, Connections): a hide must be seen by the next miss. */
  HYPERDRIVE: Hyperdrive;
}

// How long the status read may take before the request fails closed. An image is small, so a
// database that takes longer than this is treated as down rather than waited for.
const CONNECT_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 2000;

// The two lifetimes of a served file, each named once (#581). The data centre keeps an entry
// for 12 hours, so a hidden work's cached copy ages out within that (a hide does not purge:
// ARCHITECTURE, Author requests & takedowns). A browser keeps its copy for an hour from its
// fetch, and a hit hands out a fresh hour, so a hidden file can last 13 hours in a browser.
// Neither is `immutable`: these files can go away. The entry is stored under the edge's
// `max-age`, not `s-maxage`: the local Cache API honours `max-age` when it stores (not
// measured on the live zone). A browser is sent its own header on every response, hit or
// miss, so the edge's longer lifetime never reaches it.
const EDGE_SECONDS = 12 * 60 * 60;
const BROWSER_SECONDS = 60 * 60;
const EDGE_CACHE_CONTROL = `public, max-age=${EDGE_SECONDS}`;
const BROWSER_CACHE_CONTROL = `public, max-age=${BROWSER_SECONDS}`;

// The only keys this origin serves. Images are keyed by the SHA-256 of their bytes
// (ARCHITECTURE, EPUB processor step 6), so an image path is versioned by its key.
// An original's key is one plain path segment: no slash, no percent-encoding, no
// leading dot. The path is used as the R2 key undecoded, after the URL parser has
// already resolved any dot segments, encoded or not.
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const IMAGE = /^\/works\/[1-9]\d*\/img\/[0-9a-f]{64}$/;
const ORIGINAL = new RegExp(`^/originals/${SEGMENT}$`);

// Ingest stores only these image types (ARCHITECTURE, EPUB processor step 6).
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// What every response says about indexing, archiving and use for AI (ARCHITECTURE, Signals). It
// is set on the way out, so a cached entry stored without it goes out with it.
const ROBOTS_TAG = "noindex, noarchive, noai, noimageai";

/**
 * Every response this Worker returns, errors included, goes out through here with
 * `nosniff` and the robots tag (error pages the platform itself generates never reach this code). Its headers
 * are only this module's literals, so none sets a cookie; cookies a zone feature adds
 * after the Worker are kept off this host by zone config (ARCHITECTURE, Hosts).
 */
function respond(body: BodyInit | null, status: number, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Robots-Tag", ROBOTS_TAG);
  return new Response(body, { status, headers: h });
}

// The same file the app serves (ARCHITECTURE, Crawlers and agents); a Worker can't reach another's
// src, so it is written here too.
const ROBOTS_TXT = `User-agent: *
Disallow: /
Content-Signal: search=no, ai-input=no, ai-train=no
`;

// Requests the cache would answer differently from the Worker (206, 304): they skip it.
const BYPASS_HEADERS = [
  "range",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-match",
  "if-range",
];

/** Logs the kind of error only: never its message, and never the URL, which names the work. */
// oxlint-disable-next-line deslop/no-unknown-parameters -- it takes whatever a catch caught, and reads only its name
const logFailure = (what: string, error: unknown) =>
  console.error(`Content ${what}: ${error instanceof Error ? error.name : "unknown"}`);

/** The cached 200 under `url`, or undefined: a cache that fails is a miss. */
async function matchEntry(url: string) {
  try {
    return await caches.default.match(url);
  } catch (error) {
    logFailure("read", error);
    return undefined;
  }
}

/** Stores a 200 under `url`. A failed put never fails the request. */
async function putEntry(url: string, response: Response) {
  try {
    await caches.default.put(url, response);
  } catch (error) {
    logFailure("write", error);
  }
}

/**
 * The headers of a served file, one builder for the response, the stored entry and a hit, so
 * the three never differ but in their lifetime. Stored disposition is never echoed. An
 * original's type is fixed; an image keeps its stored type only when it is one of the four
 * that ingest writes. Nothing else of a stored entry (an `Age`, a validator that would make a
 * reload conditional and so skip the cache, a cookie) reaches the browser.
 */
function fileHeaders(isOriginal: boolean, storedType: string, cacheControl: string) {
  return {
    "Cache-Control": cacheControl,
    ...(isOriginal
      ? { "Content-Type": "application/epub+zip", "Content-Disposition": "attachment" }
      : { "Content-Type": IMAGE_TYPES.has(storedType) ? storedType : "application/octet-stream" }),
  };
}

const notFound = () => respond(null, 404, { "Cache-Control": "no-store" });

// A hidden work's file: the work page says 451 for the same work (ARCHITECTURE, Author requests
// & takedowns). No body and no cause, and never cached, so a restore needs no cache action.
const hiddenResponse = () => respond(null, 451, { "Cache-Control": "no-store" });

/** The row a key belongs to: an image's work by AO3 id, an original's upload by id. */
type Subject = { kind: "image"; ao3WorkId: number } | { kind: "original"; uploadId: string };

function subjectOf(path: string): Subject {
  if (IMAGE.test(path)) return { kind: "image", ao3WorkId: Number(path.split("/")[2]) };
  const segment = path.slice("/originals/".length);
  // Ingest stores `originals/<upload id>.epub`; a bare id is checked the same way (#119).
  return {
    kind: "original",
    uploadId: segment.endsWith(".epub") ? segment.slice(0, -".epub".length) : segment,
  };
}

/**
 * What may be served for `subject`: one connection and one single-row read. It throws when the
 * database can't be read, which the caller turns into a refusal, never a serve.
 */
async function readAccess(
  env: Env,
  ctx: ExecutionContext,
  subject: Subject,
): Promise<ContentAccess> {
  const db = createDb({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    queryTimeoutMillis: QUERY_TIMEOUT_MS,
  });
  try {
    return subject.kind === "image"
      ? await getImageAccess(db, subject.ao3WorkId)
      : await getOriginalAccess(db, subject.uploadId);
  } finally {
    ctx.waitUntil(db.destroy().catch(() => undefined));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const isRead = request.method === "GET" || request.method === "HEAD";
    // The one path open to a declared client, so it comes first, and only in this one spelling.
    if (isRead && path === "/robots.txt" && !request.url.includes("?")) {
      return respond(ROBOTS_TXT, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": BROWSER_CACHE_CONTROL,
      });
    }
    // Ahead of everything that depends on the path or a file, so the 403 shows nothing of which
    // files exist. Only originals have the cross-site check: images aren't throttled (spec 24).
    const isOriginal = ORIGINAL.test(path);
    const reason =
      declaredClient(request.headers) ??
      (isOriginal && isCrossSiteSubresource(request.headers) ? "cross-site subresource" : null);
    if (reason !== null) {
      // The whole line: the reason and nothing else, since a URL or address has no place in it.
      console.log(`refused: ${reason}`);
      return respond(null, 403, { "Cache-Control": "no-store" });
    }
    if (!isRead) {
      return respond(null, 405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    }
    // A query string, even an empty one (`search` is "" for a bare "?"), would make a
    // second cacheable URL for the same bytes, one that a purge of the bare URL on
    // removal would miss, so only bare paths are served.
    if (request.url.includes("?")) return notFound();
    if (!isOriginal && !IMAGE.test(path)) return notFound();

    // Only a plain GET reads or fills the cache. The key is the bare URL string, not the
    // Request, so no request header can pick a different entry, and the purge removal
    // sends (by URL for originals, by prefix for images) names exactly this key. Range and
    // conditional requests bypass it (operator ruling): they are served as before, a full
    // 200 read from R2, and never fill the cache.
    const cacheable =
      request.method === "GET" && !BYPASS_HEADERS.some((h) => request.headers.has(h));
    if (cacheable) {
      const hit = await matchEntry(request.url);
      if (hit) {
        const type = hit.headers.get("content-type") ?? "";
        return respond(hit.body, 200, fileHeaders(isOriginal, type, BROWSER_CACHE_CONTROL));
      }
    }

    // Past the cache, so a miss, or a request that never uses it: the work's status is read
    // before any byte goes out. The R2 read starts with it so the check adds no round trip, but
    // nothing is sent until the status is known. A hit above needed no read: a hidden work's
    // cached copy ages out with its entry (ARCHITECTURE, Author requests & takedowns).
    const reading = env.BUCKET.get(path.slice(1));
    reading.catch(() => undefined); // handled below, or by dropped()
    // An unread object holds a connection: whatever isn't the response is dropped.
    const dropped = () => void reading.then((o) => o?.body.cancel()).catch(() => undefined);
    // A failed read goes out through respond(), empty and uncached, and a status that could
    // not be read refuses the file however the R2 read goes. A refusal doesn't wait on R2.
    let access: ContentAccess;
    try {
      access = await readAccess(env, ctx, subjectOf(path));
    } catch (error) {
      logFailure("status read", error);
      dropped();
      return respond(null, 503, { "Cache-Control": "no-store" });
    }
    if (access !== "serve") {
      dropped();
      return access === "hidden" ? hiddenResponse() : notFound();
    }
    let object: R2ObjectBody | null;
    try {
      object = await reading;
    } catch (error) {
      logFailure("object read", error);
      return respond(null, 503, { "Cache-Control": "no-store" });
    }
    if (!object) return notFound();

    const stored = object.httpMetadata?.contentType ?? "";
    if (cacheable) {
      // Tee: the browser's response and the stored entry share the bytes, not the headers.
      const [forReader, forEntry] = object.body.tee();
      ctx.waitUntil(
        putEntry(
          request.url,
          respond(forEntry, 200, fileHeaders(isOriginal, stored, EDGE_CACHE_CONTROL)),
        ),
      );
      return respond(forReader, 200, fileHeaders(isOriginal, stored, BROWSER_CACHE_CONTROL));
    }
    return respond(object.body, 200, fileHeaders(isOriginal, stored, BROWSER_CACHE_CONTROL));
  },
} satisfies ExportedHandler<Env>;
