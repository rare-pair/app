import { describe, expect, it } from "vitest";
import { isTermsExempt } from "../src/terms";

describe("terms gate's exempt paths", () => {
  it("The terms page, the pages it links to, sign-in, sign-out, removal, /admin and static files are exempt", () => {
    for (const path of [
      "/welcome/terms",
      "/terms",
      "/privacy",
      "/about",
      "/remove",
      "/remove/x",
      "/login",
      "/login/confirm",
      "/logout",
      "/admin",
      "/admin/reports",
      "/assets",
      "/assets/site.0123456789abcdef.css",
      "/assets/waitlist/font.0123456789abcdef.woff2",
    ]) {
      expect(isTermsExempt(path), path).toBe(true);
    }
  });

  it("Exempt pages match exactly, and sections by whole segment", () => {
    for (const path of [
      "/",
      "/works/13000",
      "/works/13000/report",
      "/upload",
      "/uploads",
      "/administrator",
      "/removex",
      "/about/",
      "/aboutx",
      "/terms/",
      "/terms/x",
      "/welcome/terms/x",
      "/welcome",
      "/privacyx",
      "/assetsx/site.css",
      "/login/confirmx",
      "/logout/x",
      "/logoutx",
    ]) {
      expect(isTermsExempt(path), path).toBe(false);
    }
  });
});
