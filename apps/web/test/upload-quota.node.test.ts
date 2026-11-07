import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import {
  DEFAULT_NEW_LIMIT,
  DEFAULT_TRUSTED_LIMIT,
  limitFor,
  secondsToReset,
  signInEmailLimit,
} from "../src/quota";

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

  it("the trusted tier is never below the new-account tier", () => {
    const only = { UPLOAD_QUOTA_NEW: "500", UPLOAD_QUOTA_TRUSTED: undefined };
    expect(limitFor("admin", only)).toBe(500);
    expect(limitFor("admin", { UPLOAD_QUOTA_NEW: "50", UPLOAD_QUOTA_TRUSTED: "10" })).toBe(50);
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

describe("01-auth-magic-link: the daily limit on sign-in emails", () => {
  it("is the configured number", () => {
    expect(signInEmailLimit({ LOGIN_EMAIL_QUOTA: "9" })).toBe(9);
  });

  it("a missing, zero or malformed var keeps 5, so a typo never turns the cap off", () => {
    for (const bad of [undefined, "", "0", "-3", "1.5", "lots", "1e3", "99999999999"]) {
      expect(signInEmailLimit({ LOGIN_EMAIL_QUOTA: bad })).toBe(5);
    }
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

describe("the upload quotas in wrangler.jsonc", () => {
  const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
  const vars = rawConfig.vars ?? {};

  it("give a new account 100 uploads a day, as the operator ruled", () => {
    expect(vars.UPLOAD_QUOTA_NEW).toBe("100");
    expect(limitFor(null, vars)).toBe(100);
  });

  it("leave moderators no lower than new accounts", () => {
    expect(limitFor("admin", vars)).toBeGreaterThanOrEqual(limitFor(null, vars));
  });
});
