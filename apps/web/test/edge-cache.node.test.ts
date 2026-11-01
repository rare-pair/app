import { describe, expect, it } from "vitest";
import {
  chapterPageKey,
  fragmentCacheKey,
  pageCacheable,
  workCacheKeys,
  workCacheTag,
} from "../src/edge-cache";

// The edge cache's names, which XR1b's purge depends on, and which requests may use the
// page cache at all (operator ruling on #54: signed out, no settings cookie; and no
// session or flash cookie either).
const VERSION = "0f0e0d0c-0000-4000-8000-000000000001";

describe("edge cache keys", () => {
  it("names a chapter page by its public URL on the bare domain", () => {
    expect(chapterPageKey(25001, 3)).toBe("https://rarepair.fans/works/25001/chapters/3");
  });

  it("names a fragment by its chapter's public URL plus the version", () => {
    expect(fragmentCacheKey(25001, 3, VERSION)).toBe(
      `https://rarepair.fans/works/25001/chapters/3?version=${VERSION}`,
    );
  });

  it("tags every entry with the work's ID", () => {
    expect(workCacheTag(25001)).toBe("work-25001");
  });

  it("lists every page and fragment key of a work's version", () => {
    expect(workCacheKeys(25001, { id: VERSION }, [{ n: 1 }, { n: 2 }])).toEqual([
      "https://rarepair.fans/works/25001/chapters/1",
      "https://rarepair.fans/works/25001/chapters/2",
      `https://rarepair.fans/works/25001/chapters/1?version=${VERSION}`,
      `https://rarepair.fans/works/25001/chapters/2?version=${VERSION}`,
    ]);
  });
});

describe("pageCacheable", () => {
  const signedOut = false;

  it("lets a signed-out GET or HEAD with no cookies use the page cache", () => {
    expect(pageCacheable("GET", {}, signedOut)).toBe(true);
    expect(pageCacheable("HEAD", {}, signedOut)).toBe(true);
  });

  it("keeps the warned cookie eligible, since the page doesn't depend on it", () => {
    expect(pageCacheable("GET", { "__Host-warned": "25001" }, signedOut)).toBe(true);
  });

  it("skips the page cache for a settings, session or flash cookie", () => {
    for (const cookie of [
      "__Host-reader",
      "__Secure-better-auth.session_token",
      "__Secure-better-auth.session_data",
      "__Host-flash",
    ]) {
      expect(pageCacheable("GET", { [cookie]: "x" }, signedOut), cookie).toBe(false);
    }
  });

  it("skips the page cache for a signed-in reader and for other methods", () => {
    expect(pageCacheable("GET", {}, true)).toBe(false);
    expect(pageCacheable("POST", {}, signedOut)).toBe(false);
  });
});
