import { describe, expect, it } from "vitest";
import {
  WARNED_COOKIE,
  needsWarnings,
  parseWarned,
  safeWarningsNext,
  warnedCookie,
} from "../src/warnings";

const work = (rating: string | null, warnings: string[] = []) => ({
  work: { rating },
  tags: warnings.map((name) => ({ type: "warning" as const, name, name_norm: name.toLowerCase() })),
});

describe("12-warnings-interstitial: which works need the screen", () => {
  it.each(["Mature", "Explicit", "Not Rated"])("%s needs it", (rating) => {
    expect(needsWarnings(work(rating))).toBe(true);
  });
  it.each([null, "", "  "])("no rating (%j) needs it", (rating) => {
    expect(needsWarnings(work(rating))).toBe(true);
  });
  it("a warning tag needs it", () => {
    expect(needsWarnings(work("Teen And Up Audiences", ["Graphic Depictions Of Violence"]))).toBe(
      true,
    );
    expect(
      needsWarnings(work("Teen And Up Audiences", ["Creator Chose Not To Use Archive Warnings"])),
    ).toBe(true);
  });
  it.each(["mature", "EXPLICIT", "Explicit Audiences", "Mature Audiences"])(
    "an odd spelling (%s) of a strong or unknown rating needs it",
    (rating) => {
      expect(needsWarnings(work(rating))).toBe(true);
    },
  );
  it("General or Teen with no warnings, or only No Archive Warnings Apply, skips it", () => {
    expect(needsWarnings(work("General Audiences"))).toBe(false);
    expect(needsWarnings(work("Teen And Up Audiences", ["No Archive Warnings Apply"]))).toBe(false);
  });
});

describe("12-warnings-interstitial: the seen cookie", () => {
  it("reads work IDs and drops anything else", () => {
    expect(parseWarned("12.0.abc.007.34.-5.1e3.12")).toEqual([12, 34]);
    expect(parseWarned(undefined)).toEqual([]);
  });
  it("keeps the 50 newest", () => {
    const ids = Array.from({ length: 80 }, (_, i) => i + 1);
    const kept = parseWarned(ids.join("."));
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe(31);
    expect(kept.at(-1)).toBe(80);
  });
  it("is a session cookie with the flags", () => {
    const cookie = warnedCookie([5, 6]);
    expect(cookie).toBe(`${WARNED_COOKIE}=5.6; Path=/; SameSite=Lax; Secure; HttpOnly`);
    expect(WARNED_COOKIE).toBe("__Host-warned");
    expect(cookie).not.toMatch(/Max-Age|Expires|Domain/i);
  });
});

describe("12-warnings-interstitial: where Continue goes", () => {
  it("accepts this work's chapter or full page only", () => {
    expect(safeWarningsNext(7, "/works/7/chapters/3")).toBe("/works/7/chapters/3");
    expect(safeWarningsNext(7, "/works/7/full")).toBe("/works/7/full");
  });
  it.each([
    "/admin",
    "//evil.example/works/7/full",
    "https://evil.example/",
    "/works/8/chapters/3",
    "/works/7/chapters/03",
    "/works/7/chapters/3?x=1",
    "/works/7/full/",
    "/works/7/chapters/3\r\nSet-Cookie: a=b",
    undefined,
  ])("falls back to chapter 1 for %j", (next) => {
    expect(safeWarningsNext(7, next)).toBe("/works/7/chapters/1");
  });
});
