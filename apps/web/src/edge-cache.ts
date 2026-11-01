// The Worker's Cache API entries (ARCHITECTURE, Reading, Caching): chapter fragments,
// kept a year since each version has its own, and the chapter page for a signed-out
// reader with no settings cookie, kept 60 s (operator ruling on #54). The page entry
// holds no nonce: each response is built around a fresh one. Every entry carries the
// work's Cache-Tag, so a purge (XR1b) takes them all, in every data centre.

import { SESSION_COOKIE } from "./auth";
import { FLASH_COOKIE, SETTINGS_COOKIE } from "./reader-settings";

/**
 * The origin of every key: the bare domain, never the request's URL, so `www`, a port,
 * a trailing dot or a query string can't make entries of their own.
 */
export const CACHE_ORIGIN = "https://rarepair.fans";

/** A chapter page's key: its public URL, from the two validated numbers only. */
export const chapterPageKey = (id: number, n: number) =>
  `${CACHE_ORIGIN}/works/${id}/chapters/${n}`;

/**
 * A chapter fragment's key: its chapter's public URL plus the version's ID, so a new
 * version never meets an old version's fragment.
 */
export const fragmentCacheKey = (id: number, n: number, versionId: string) =>
  `${chapterPageKey(id, n)}?version=${encodeURIComponent(versionId)}`;

/** The Cache-Tag on every entry of a work, pages and fragments alike: purge by this. */
export const workCacheTag = (id: number) => `work-${id}`;

/**
 * Every key a version of a work can hold: its chapter pages, then its fragments. A purge
 * by tag is the complete one; this list covers the version given only.
 */
export const workCacheKeys = (id: number, version: { id: string }, chapters: { n: number }[]) => [
  ...chapters.map((ch) => chapterPageKey(id, ch.n)),
  ...chapters.map((ch) => fragmentCacheKey(id, ch.n, version.id)),
];

// Better Auth's cookies all start with this; the session token is one of them.
const AUTH_COOKIE_PREFIX = SESSION_COOKIE.slice(0, SESSION_COOKIE.indexOf(".") + 1);

/**
 * Whether a request may read and fill the page cache: a GET or HEAD, signed out, with no
 * settings, flash or Better Auth cookie, since each of those changes the page or means
 * an account. A stale session cookie counts too. The warned cookie doesn't: the page
 * doesn't depend on it, and the warnings gate runs on every hit.
 */
export function pageCacheable(method: string, cookies: Record<string, string>, signedIn: boolean) {
  if ((method !== "GET" && method !== "HEAD") || signedIn) return false;
  return Object.keys(cookies).every(
    (name) =>
      name !== SETTINGS_COOKIE && name !== FLASH_COOKIE && !name.startsWith(AUTH_COOKIE_PREFIX),
  );
}

/** What a fragment entry is kept for: a year, since a version's fragments never change. */
const FRAGMENT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * A fresh entry for the cache, with only our own headers: never one copied from R2 or
 * a response, so no `Set-Cookie` or `private` can reach it.
 */
const entry = (body: BodyInit, id: number, cacheControl: string, contentType: string) =>
  new Response(body, {
    headers: {
      "Cache-Control": cacheControl,
      "Cache-Tag": workCacheTag(id),
      "Content-Type": contentType,
    },
  });

/** Logs the kind of error only: never its message or the key, which name the work. */
// oxlint-disable-next-line deslop/no-unknown-parameters -- it takes whatever a catch caught, and reads only its name
const logFailure = (what: string, error: unknown) =>
  console.error(`Edge cache ${what}: ${error instanceof Error ? error.name : "unknown"}`);

/** The cached entry under `key`, or undefined: a cache that fails is a miss. */
async function matchEntry(cache: Cache, key: string) {
  try {
    return await cache.match(key);
  } catch (error) {
    logFailure("read", error);
    return undefined;
  }
}

/** Stores `response` under `key`. A failed put never fails the page. */
async function putEntry(cache: Cache, key: string, response: Response) {
  try {
    await cache.put(key, response);
  } catch (error) {
    logFailure("write", error);
  }
}

/** One chapter of one version: its number, and its R2 key, already checked by the caller. */
export interface FragmentRef {
  id: number;
  n: number;
  versionId: string;
  r2Key: string;
}

/**
 * A chapter fragment's text, from the cache, else from R2 and then kept. Null when R2
 * has no such object, which is never cached; an R2 failure throws. The key must have
 * passed `isFragmentKey`, so nothing but a sanitized fragment ever enters the cache.
 */
export async function fragmentText(
  cache: Cache,
  bucket: Pick<R2Bucket, "get">,
  { id, n, versionId, r2Key }: FragmentRef,
) {
  const key = fragmentCacheKey(id, n, versionId);
  const hit = await matchEntry(cache, key);
  if (hit) return hit.text();
  const object = await bucket.get(r2Key);
  if (!object) return null;
  const text = await object.text();
  // Awaited: the text is already in hand, so the put adds little.
  await putEntry(cache, key, fragmentEntry(text, id));
  return text;
}

const fragmentEntry = (body: BodyInit, id: number) =>
  entry(body, id, FRAGMENT_CACHE_CONTROL, "text/html; charset=utf-8");

/**
 * A version's fragments as streams, from the cache, else from R2 while a copy goes into
 * the cache in `waitUntil`, so the reader never waits on the put. `chapters` are the
 * version's own, every key already checked by the caller; any other key is read from
 * R2 alone and never cached.
 */
export function cachedFragments(
  cache: Cache,
  bucket: Pick<R2Bucket, "get">,
  waitUntil: (promise: Promise<unknown>) => void,
  id: number,
  versionId: string,
  chapters: { n: number; r2_key: string }[],
) {
  return {
    async get(r2Key: string) {
      const n = chapters.find((ch) => ch.r2_key === r2Key)?.n;
      if (n === undefined) return bucket.get(r2Key);
      const key = fragmentCacheKey(id, n, versionId);
      const hit = await matchEntry(cache, key);
      if (hit?.body) return { body: hit.body };
      const object = await bucket.get(r2Key);
      if (!object) return null;
      const [mine, kept] = object.body.tee();
      waitUntil(putEntry(cache, key, fragmentEntry(kept, id)));
      return { body: mine };
    },
  };
}

/** How long a chapter page is kept at the edge (operator ruling on #54). */
const PAGE_CACHE_CONTROL = "public, max-age=60";

/**
 * A chapter page as the edge cache keeps it: everything the handler built from the
 * database, and nothing from the request. No nonce and no fragment: each response is
 * built around its own nonce, with the fragment read through the fragment cache.
 */
export interface ChapterPage {
  /** The work's AO3 ID and the chapter's number, as in the key. */
  id: number;
  n: number;
  /** The document's title, and the reader bar that is its one h1. */
  title: string;
  bar: string;
  /** The page's main content before the chapter's article and after it. */
  top: string;
  bottom: string;
  /** The chapter's fragment, and its version's prefix, to check its key again. */
  fragment: FragmentRef;
  prefix: string;
  /** Whether the work gets the warnings screen. A signed-out reader can't turn it off. */
  screen: boolean;
}

/**
 * The page entry's shape, raised whenever `ChapterPage` changes, so an entry an earlier
 * deploy left is a miss rather than a page built from the wrong fields.
 */
const PAGE_FORMAT = 1;

/** What a page entry holds. Only this Worker writes it. */
interface StoredPage {
  format: number;
  page: ChapterPage;
}

/**
 * The edge-cached page for chapter `n` of work `id`, or null. An entry of another
 * format, for another chapter, or that doesn't parse is a miss.
 */
export async function cachedChapterPage(cache: Cache, id: number, n: number) {
  const hit = await matchEntry(cache, chapterPageKey(id, n));
  if (!hit) return null;
  try {
    const { format, page } = await hit.json<StoredPage>();
    const same = (ref: { id: number; n: number }) => ref.id === id && ref.n === n;
    return format === PAGE_FORMAT && same(page) && same(page.fragment) ? page : null;
  } catch (error) {
    logFailure("entry", error);
    return null;
  }
}

/** Keeps `page` at the edge for 60 s, tagged with its work. */
export function storeChapterPage(cache: Cache, page: ChapterPage) {
  const stored: StoredPage = { format: PAGE_FORMAT, page };
  return putEntry(
    cache,
    chapterPageKey(page.id, page.n),
    entry(JSON.stringify(stored), page.id, PAGE_CACHE_CONTROL, "application/json"),
  );
}
