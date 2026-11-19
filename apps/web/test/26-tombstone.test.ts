import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { LOGO_PATH } from "../src/logo";
import { ROBOTS_TXT } from "../src/robots";
import { STYLESHEET_PATH } from "../src/styles";
import { BASE, STRICT, TURNSTILE, withoutNonce } from "./helpers";

// Runs in the "open" project, where TOMBSTONE is "off"; each request here turns it back on, as
// wrangler.jsonc deploys it (26-tombstone.node.test.ts checks the file).
type Bindings = typeof env & { TOMBSTONE?: string };
const closed: Bindings = { ...env, TOMBSTONE: "on" };

const send = (path: string, init: RequestInit = {}, bindings: Bindings = closed) =>
  app.fetch(
    new Request(new URL(path, BASE), { redirect: "manual", ...init }),
    bindings,
    createExecutionContext(),
  );

// Pages, forms, a session-only page, the admin area and a path nothing serves.
const PATHS = [
  "/",
  "/works/1",
  "/works/1/chapters/1",
  "/works/1/full",
  "/tags/fandom/x",
  "/search?q=x",
  "/login",
  "/upload",
  "/me/uploads",
  "/remove",
  "/dmca",
  "/about",
  "/admin",
  "/nothing-here",
];

describe("26-tombstone", () => {
  it("Every page is the tombstone: a 410 that sends no cookie and is never stored", async () => {
    for (const path of PATHS) {
      const res = await send(path);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("set-cookie"), path).toBeNull();
      expect(res.headers.get("strict-transport-security"), path).toContain("max-age=31536000");
      expect(res.headers.get("x-robots-tag"), path).toContain("noindex");
      // The strict policy; the Turnstile paths add the challenge frame, keyed on path.
      const csp = withoutNonce(res.headers.get("content-security-policy"));
      expect(csp === STRICT || csp === TURNSTILE, path).toBe(true);
      const html = await res.text();
      expect(html, path).toContain("<h1>rarepair has closed</h1>");
      expect(html, path).toContain(`mailto:${env.NOTICES_EMAIL}`);
    }
  });

  it("Every write is refused the same way, before the session or a form is read", async () => {
    const cookie = "__Secure-better-auth.session_token=forged";
    for (const [method, path] of [
      ["POST", "/login"],
      ["POST", "/uploads"],
      ["PUT", "/uploads/00000000-0000-0000-0000-000000000000"],
      ["DELETE", "/uploads/00000000-0000-0000-0000-000000000000"],
      ["POST", "/uploads/00000000-0000-0000-0000-000000000000/complete"],
      ["POST", "/remove"],
      ["POST", "/dmca"],
      ["POST", "/waitlist"],
      ["POST", "/works/1/report"],
      ["POST", "/logout"],
    ] as const) {
      const res = await send(path, {
        method,
        headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
        body: "a=b",
      });
      expect(res.status, `${method} ${path}`).toBe(410);
      expect(await res.text()).toContain("rarepair has closed");
    }
  });

  it("The page's stylesheet and icon, and robots.txt, are still served", async () => {
    const css = await send(STYLESHEET_PATH);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const logo = await send(LOGO_PATH);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    const robots = await send("/robots.txt");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe(ROBOTS_TXT);
  });

  it("www still goes to the bare domain first", async () => {
    const res = await send("https://www.rarepair.fans/works/1");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://rarepair.fans/works/1");
  });

  it("A missing or misspelt TOMBSTONE keeps the archive closed; only off opens it", async () => {
    for (const TOMBSTONE of [undefined, "", "false", "OFF", "0"]) {
      const res = await send("/about", {}, { ...env, TOMBSTONE });
      expect(res.status, String(TOMBSTONE)).toBe(410);
    }
    expect((await send("/about", {}, { ...env, TOMBSTONE: "off" })).status).toBe(200);
  });
});
