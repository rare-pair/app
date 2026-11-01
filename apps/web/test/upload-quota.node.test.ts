import { describe, expect, it } from "vitest";
import { DEFAULT_NEW_LIMIT, DEFAULT_TRUSTED_LIMIT, limitFor, secondsToReset } from "../src/quota";

const vars = { UPLOAD_QUOTA_NEW: "7", UPLOAD_QUOTA_TRUSTED: "40" };

describe("19-surge-controls-and-quotas", () => {
  it("Brand-new accounts get the lower quota", () => {
    expect(limitFor(null, vars)).toBe(7);
    // A role that isn't a moderator's is no better than none, whatever its spelling.
    for (const role of ["user", "Admin", "moderators", ""]) expect(limitFor(role, vars)).toBe(7);
  });

  it("Trusted users get the higher quota", () => {
    expect(["moderator", "admin"].map((role) => limitFor(role, vars))).toEqual([40, 40]);
    expect(limitFor("admin", vars)).toBeGreaterThan(limitFor(null, vars));
  });

  it("a missing, zero or malformed var keeps the default, so a typo never opens or closes the quota", () => {
    for (const bad of [undefined, "", "0", "-3", "1.5", "lots", "1e3", "99999999999"]) {
      const broken = { UPLOAD_QUOTA_NEW: bad, UPLOAD_QUOTA_TRUSTED: bad };
      expect(limitFor(null, broken)).toBe(DEFAULT_NEW_LIMIT);
      expect(limitFor("admin", broken)).toBe(DEFAULT_TRUSTED_LIMIT);
    }
    expect(DEFAULT_TRUSTED_LIMIT).toBeGreaterThan(DEFAULT_NEW_LIMIT);
  });
});

describe("secondsToReset", () => {
  it("counts to the next midnight UTC, rounded up", () => {
    expect(secondsToReset(new Date("2026-11-01T23:00:00Z"))).toBe(3600);
    expect(secondsToReset(new Date("2026-11-01T23:59:59.500Z"))).toBe(1);
    expect(secondsToReset(new Date("2026-11-01T12:00:00.001Z"))).toBe(43200);
  });

  it("is a whole day just after midnight, never zero", () => {
    expect(secondsToReset(new Date("2026-11-02T00:00:00Z"))).toBe(86400);
    expect(secondsToReset(new Date("2026-12-31T23:59:59.999Z"))).toBe(1);
  });
});
