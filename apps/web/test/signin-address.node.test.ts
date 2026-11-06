import { describe, expect, it } from "vitest";
import { maskEmail } from "../src/signin-address";

describe("01-auth-magic-link", () => {
  describe("The button page names the account, masked", () => {
    it.each([
      ["jane@example.com", "j***@example.com"],
      ["j@example.com", "j***@example.com"],
      ["Jane.Doe+tag@Example.COM", "j***@example.com"],
      ["émile@example.com", "é***@example.com"],
      ["\u{1D4BF}ane@example.com", "\u{1D4BF}***@example.com"],
      ['"a@b"@example.com', '"***@example.com'],
    ])("%s shows as %s", (email, masked) => {
      expect(maskEmail(email)).toBe(masked);
    });

    it.each(["", "no-at-sign", "@example.com", "jane@"])("%j isn't an address to show", (email) => {
      expect(maskEmail(email)).toBeNull();
    });
  });
});
