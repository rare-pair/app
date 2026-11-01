import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipHash } from "../src/ip-hash";
import {
  BASE,
  fetchW,
  freshIp,
  LOGIN_TOKEN,
  nonceOf,
  REMOVE_TOKEN,
  TURNSTILE,
  UPLOAD_TOKEN,
  WAITLIST_TOKEN,
  withoutNonce,
} from "./helpers";

// One database serves every test file in the run, so this file keeps to AO3 work IDs
// 12600 to 12699 and finds its requests by its own `example.test` contact emails.
// Everything here is synthetic.
const W = 12600;
/** No work has it. */
const UNKNOWN = 12699;
const WORK_URL = `${BASE}/works/${W}`;
const RECEIVED = "Your request was received; a moderator will review it and email you.";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  await seedWork(db, {
    ao3WorkId: W,
    title: "x1 Work W",
    tags: [
      { type: "rating", name: "x1-General Audiences" },
      { type: "fandom", name: "x1-Fandom" },
    ],
  });
});
afterAll(() => db.destroy());

/** The requests stored for a contact email. */
const requestsFrom = (email: string) =>
  db.selectFrom("requests").selectAll().where("contact_email", "=", email).execute();

/**
 * Submits the form as a browser on rarepair.fans does, from `ip` (none when null), with
 * a passing token unless `token` says otherwise.
 */
const post = (
  fields: Record<string, string>,
  {
    ip = freshIp(),
    headers = {},
    body = new URLSearchParams({ "cf-turnstile-response": REMOVE_TOKEN, ...fields }).toString(),
  }: { ip?: string | null; headers?: Record<string, string>; body?: string } = {},
) => {
  const sent = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    origin: BASE,
    "sec-fetch-site": "same-origin",
    ...headers,
  });
  if (ip !== null) sent.set("cf-connecting-ip", ip);
  return fetchW("/remove", { method: "POST", headers: sent, body });
};

describe("16-removal-and-opt-out", () => {
  it("Form needs no sign-in", async () => {
    const res = await fetchW("/remove");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(TURNSTILE);
    const html = await res.text();
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/remove"/);
    for (const name of ["email", "work", "pseud", "statement"]) {
      expect(html, name).toMatch(new RegExp(`<(?:input|textarea)[^>]*name="${name}"`));
    }
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('data-action="remove"');
    expect(html).not.toContain("/login");
  });

  it("Removal form without JavaScript explains it is needed and gives the moderators' contact address", async () => {
    const res = await fetchW("/remove");
    const html = await res.text();
    const nonce = nonceOf(res.headers.get("content-security-policy"));
    const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] ?? "";
    expect(noscript).toContain("JavaScript");
    expect(env.MODERATORS_EMAIL).not.toBe("");
    expect(noscript).toContain(env.MODERATORS_EMAIL);
    // Nothing can be submitted without the script that shows the form.
    expect(html).toMatch(/<form\b[^>]*\bhidden\b/);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  });

  it("Footer link reaches the form", async () => {
    const about = await (await fetchW("/about")).text();
    const href = about.match(/<footer>[\s\S]*?<a href="([^"]+)">Remove my work<\/a>/)?.[1];
    expect(href).toBeDefined();
    const res = await fetchW(href ?? "/missing");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/remove"');
  });

  it("Work is prefilled from the work page", async () => {
    const value = async (query: string) => {
      const html = await (await fetchW(`/remove${query}`)).text();
      return html.match(/<input[^>]*name="work"[^>]*>/)?.[0] ?? "";
    };
    expect(await value(`?work=${W}`)).toContain(`value="${WORK_URL}"`);
    // Nothing is read about the work, so a work nobody has gets the same field.
    expect(await value(`?work=${UNKNOWN}`)).toContain(`value="${BASE}/works/${UNKNOWN}"`);
    expect(await value("")).not.toContain("value=");
    for (const bad of ["abc", "0", "12345678901", "1%3Cb%3E", "%22%3E%3Cscript%3E"]) {
      const field = await value(`?work=${bad}`);
      expect(field, bad).not.toContain("value=");
      expect(field, bad).not.toContain("<script");
    }
  });

  it("Form says there is no proof of identity", async () => {
    const html = await (await fetchW("/remove")).text();
    expect(html).toContain("proof of identity");
  });

  describe("Missing Turnstile is refused", () => {
    const email = "x1-turnstile@example.test";
    const fields = { email, work: WORK_URL, statement: "x1 statement" };

    it.each([
      ["no token", undefined],
      ["an empty token", ""],
      ["a token for the sign-in form", LOGIN_TOKEN],
      ["a token for the wait list", WAITLIST_TOKEN],
      ["a token for uploads", UPLOAD_TOKEN],
      ["a token no form owns", "XXXX.DUMMY.TOKEN.XXXX"],
    ])("refuses %s, shows the form again and stores nothing", async (_, token) => {
      const body = new URLSearchParams(fields);
      if (token !== undefined) body.set("cf-turnstile-response", token);
      const res = await post({}, { body: body.toString() });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("The anti-spam check did not pass.");
      expect(html).toContain('action="/remove"');
      // What was typed comes back.
      expect(html).toContain(`value="${email}"`);
      expect(await requestsFrom(email)).toEqual([]);
    });

    it("answers 503 when the check can't be reached, and stores nothing", async () => {
      const res = await post({ ...fields, "cf-turnstile-response": "siteverify-down" });
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("The anti-spam check is not answering");
      expect(await requestsFrom(email)).toEqual([]);
    });

    it("refuses a post from another origin before reading it, storing nothing", async () => {
      const res = await post(fields, { headers: { origin: "https://evil.example" } });
      expect(res.status).toBe(403);
      expect(await requestsFrom(email)).toEqual([]);
    });

    it("answers 413 to a body too large, showing the form empty", async () => {
      const res = await post(fields, { body: `statement=${"a".repeat(70 * 1024)}` });
      expect(res.status).toBe(413);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain('action="/remove"');
    });
  });

  describe("Missing fields are refused", () => {
    /** The attributes of the form control named `name`. */
    const control = (html: string, name: string) =>
      html.match(new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

    it("refuses a missing, blank or unsendable contact email, marking the field", async () => {
      for (const email of ["", "   ", "not an address", `${"a".repeat(250)}@example.test`]) {
        const res = await post({ email, work: WORK_URL, statement: "x1 missing email" });
        expect(res.status, email).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        const field = control(html, "email");
        expect(field, email).toContain('aria-invalid="true"');
        expect(field).toContain('aria-describedby="email-error"');
        expect(html).toMatch(/id="email-error"[^>]*>[^<]*email/i);
        // The other fields are not marked, and keep what was typed.
        const work = control(html, "work");
        expect(work).not.toContain("aria-invalid");
        expect(work).toContain(`value="${WORK_URL}"`);
        expect(html).toContain("x1 missing email");
      }
      const stored = await db
        .selectFrom("requests")
        .select("id")
        .where("statement", "=", "x1 missing email")
        .execute();
      expect(stored).toEqual([]);
    });

    it("refuses neither a work nor a pseud, marking both", async () => {
      const email = "x1-neither@example.test";
      const blanks: Record<string, string>[] = [{}, { work: "  ", pseud: "  " }];
      for (const blank of blanks) {
        const res = await post({ email, statement: "x1 neither", ...blank });
        expect(res.status).toBe(400);
        const html = await res.text();
        for (const name of ["work", "pseud"]) {
          expect(control(html, name), name).toContain('aria-invalid="true"');
          expect(control(html, name), name).toContain(`aria-describedby="${name}-error"`);
        }
        expect(html).toContain(`value="${email}"`);
        expect(control(html, "email")).not.toContain("aria-invalid");
      }
      expect(await requestsFrom(email)).toEqual([]);
    });

    it("refuses both missing at once, marking each", async () => {
      const res = await post({ email: "", statement: "x1 both" });
      expect(res.status).toBe(400);
      const html = await res.text();
      for (const name of ["email", "work", "pseud"]) {
        expect(control(html, name), name).toContain('aria-invalid="true"');
      }
      const stored = await db
        .selectFrom("requests")
        .select("id")
        .where("statement", "=", "x1 both")
        .execute();
      expect(stored).toEqual([]);
    });

    it("keeps what was typed, escaped", async () => {
      const markup = `"><script>alert(1)</script>`;
      const res = await post({ email: "", work: markup, statement: markup });
      const html = await res.text();
      expect(res.status).toBe(400);
      expect(html).not.toContain("<script>alert(1)");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("refuses a statement over its limit, keeping what was typed", async () => {
      const email = "x1-long-statement@example.test";
      const res = await post({ email, work: WORK_URL, statement: "s".repeat(2001) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("2000 characters");
      expect(await requestsFrom(email)).toEqual([]);
    });
  });

  describe("Requests record a hashed IP", () => {
    it("stores a removal's row with the keyed hash of the IP and no part of the address", async () => {
      const email = "x1-hashed@example.test";
      const ip = "198.51.100.23";
      const res = await post({ email, work: WORK_URL, statement: "x1 statement" }, { ip });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain(RECEIVED);
      // It says nothing of the work or of any hiding.
      expect(html).not.toMatch(/hidden|hide/i);
      expect(html).not.toContain(ip);

      const [row, ...rest] = await requestsFrom(email);
      expect(rest).toEqual([]);
      expect(row?.kind).toBe("remove_work");
      expect(row?.status).toBe("pending");
      expect(row?.pseud_norm).toBeNull();
      expect(row?.statement).toBe("x1 statement");
      expect(row?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.ip_hash).not.toContain(ip);
      expect(row?.ip_hash).toBe(await ipHash(env.IP_HASH_KEY, ip));
      // Its work is the works row, not the AO3 id.
      const work = await db
        .selectFrom("works")
        .select("id")
        .where("ao3_work_id", "=", W)
        .executeTakeFirstOrThrow();
      expect(row?.work_id).toBe(work.id);
      // Nothing is hidden by it.
      const after = await db
        .selectFrom("works")
        .select("status")
        .where("ao3_work_id", "=", W)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe("live");
    });

    it("stores the same hash for the same IP and another for another", async () => {
      const ip = "198.51.100.24";
      const fields = { work: `archiveofourown.org/works/${W}`, statement: "x1 statement" };
      await post({ ...fields, email: "x1-same-a@example.test" }, { ip });
      await post({ ...fields, email: "x1-same-b@example.test" }, { ip });
      await post({ ...fields, email: "x1-other@example.test" }, { ip: "198.51.100.25" });
      const hash = async (email: string) => (await requestsFrom(email))[0]?.ip_hash;
      const same = await hash("x1-same-a@example.test");
      expect(same).toMatch(/^[0-9a-f]{64}$/);
      expect(await hash("x1-same-b@example.test")).toBe(same);
      expect(await hash("x1-other@example.test")).not.toBe(same);
    });

    it("stores the hash of the unknown marker when the request has no address", async () => {
      const email = "x1-no-ip@example.test";
      const res = await post({ email, work: WORK_URL, statement: "x1" }, { ip: null });
      expect(res.status).toBe(200);
      const [row] = await requestsFrom(email);
      expect(row?.ip_hash).toBe(await ipHash(env.IP_HASH_KEY, null));
    });

    it("stores a pseud's opt-out request under its normalized pseud, hiding nothing", async () => {
      const email = "x1-pseud@example.test";
      const res = await post({ email, pseud: "  Moon   CHILD ", statement: "" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(RECEIVED);
      const [row, ...rest] = await requestsFrom(email);
      expect(rest).toEqual([]);
      expect(row?.kind).toBe("opt_out");
      expect(row?.pseud_norm).toBe("moon child");
      expect(row?.work_id).toBeNull();
      expect(row?.statement).toBe("");
      expect(row?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      const optouts = await db
        .selectFrom("optouts")
        .select("id")
        .where("request_id", "=", row?.id ?? "")
        .execute();
      expect(optouts).toEqual([]);
    });

    it("answers a work the archive doesn't hold with the same page, storing nothing for now", async () => {
      // X2 (#62) gives this its own page; until then it reads the same as any request.
      const email = "x1-unknown-work@example.test";
      const res = await post({ email, work: `${BASE}/works/${UNKNOWN}`, statement: "x1" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(RECEIVED);
      expect(await requestsFrom(email)).toEqual([]);
    });

    it("takes the work, and not the pseud, when both are given", async () => {
      const email = "x1-both@example.test";
      await post({ email, work: WORK_URL, pseud: "Someone", statement: "x1" });
      const [row] = await requestsFrom(email);
      expect(row?.kind).toBe("remove_work");
      expect(row?.pseud_norm).toBeNull();
    });
  });
});
