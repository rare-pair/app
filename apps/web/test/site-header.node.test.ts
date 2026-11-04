import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headerLinks } from "../src/site-header";

describe("20-site-chrome-and-legal: the header's links", () => {
  const texts = (html: string) =>
    [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim()).filter((text) => text !== "");

  it("Signed out, Add work then Sign in", () => {
    const html = headerLinks({ signedIn: false, moderator: false });
    expect(texts(html)).toEqual(["Add work", "Sign in"]);
    expect(html).toContain('<a href="/login">Sign in</a>');
    expect(html).not.toMatch(/<form|<button/);
  });

  it("Signed in, My uploads and a Sign out form last", () => {
    const html = headerLinks({ signedIn: true, moderator: false });
    expect(texts(html)).toEqual(["Add work", "My uploads", "Sign out"]);
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).not.toContain("/admin");
  });

  it("A moderator's Admin comes before Sign out", () => {
    const html = headerLinks({ signedIn: true, moderator: true });
    expect(texts(html)).toEqual(["Add work", "My uploads", "Admin", "Sign out"]);
  });

  it("The nav is labelled, so it is told apart from the chapter navs", () => {
    expect(headerLinks({ signedIn: false, moderator: false })).toContain('<nav aria-label="Site">');
  });

  it("The module reads no database: the role comes with the session", () => {
    const source = readFileSync(new URL("../src/site-header.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createDb|HYPERDRIVE/);
  });
});
