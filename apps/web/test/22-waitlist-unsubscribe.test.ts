import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/waitlist";
import { consoleDuring, fetchW, STRICT, withoutNonce } from "./helpers";

// Runs in the "open" project (PRELAUNCH off): the unsubscribe link keeps working after launch.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const NOTIFIED = new Date("2026-11-01T10:00:00Z");
const HSTS = "max-age=31536000; includeSubDomains";

/** A token shaped like the ones the launch send issues: 43 base64url characters. */
const newToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A confirmed, already-mailed address with its unsubscribe token's hash. Returns the token. */
async function mailedAddress(name: string) {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const token = newToken();
  await db
    .insertInto("waitlist")
    .values({
      email,
      confirmed_at: NOTIFIED,
      notified_at: NOTIFIED,
      unsubscribe_token_hash: await hashToken(token),
    })
    .execute();
  return { email, token };
}

const rowCount = async (email: string) =>
  (await db.selectFrom("waitlist").select("email").where("email", "=", email).execute()).length;

const link = (token: string) => `/waitlist/unsubscribe?token=${encodeURIComponent(token)}`;

/** What a mail provider sends for one-click unsubscribe (RFC 8058): no cookie, no Origin. */
const providerPost = (token: string, headers: Record<string, string> = {}) =>
  fetchW(link(token), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "List-Unsubscribe=One-Click",
  });

describe("22-waitlist", () => {
  it("Opening the unsubscribe link changes nothing and shows an Unsubscribe button", async () => {
    const { email, token } = await mailedAddress("opening");

    for (let i = 0; i < 2; i++) {
      const res = await fetchW(link(token));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
      expect(res.headers.get("strict-transport-security")).toBe(HSTS);
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
      expect(res.headers.get("set-cookie")).toBeNull();
      const html = await res.text();
      expect(html).toMatch(
        new RegExp(`<form[^>]*method="post"[^>]*action="/waitlist/unsubscribe\\?token=${token}"`),
      );
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Unsubscribe<\/button>/);
      expect(html).not.toMatch(/<script/);
    }

    expect(await rowCount(email)).toBe(1);
  });

  it("A link with no token, or a silly one, shows the refused page and echoes nothing", async () => {
    for (const query of ["", "?token=", `?token=${"a".repeat(300)}`, "?token=%3Cb%3Ex%3C/b%3E"]) {
      for (const method of ["GET", "POST"]) {
        const res = await fetchW(`/waitlist/unsubscribe${query}`, { method });
        expect(res.status, `${method} ${query}`).toBe(400);
        const html = await res.text();
        expect(html, query).toMatch(/link doesn&#39;t work/);
        expect(html, query).not.toContain("<b>x</b>");
        expect(html, query).not.toContain("aaaaaaaaaaaaaaaaaaaa");
      }
    }
  });

  it("A mail provider's one-click POST deletes the row and answers 200 with no sign-in", async () => {
    const { email, token } = await mailedAddress("oneclick");
    const other = await mailedAddress("bystander");

    const res = await providerPost(token);

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    const html = await res.text();
    expect(html).toContain("<h1>You&#39;re unsubscribed</h1>");
    expect(html).not.toContain(email);
    expect(html).not.toContain(token);
    expect(await rowCount(email)).toBe(0);
    expect(await rowCount(other.email)).toBe(1);
  });

  it("The unsubscribe POST has no Origin check: a foreign Origin works too", async () => {
    const { email, token } = await mailedAddress("foreign");

    const res = await providerPost(token, {
      origin: "https://mail.example.test",
      "sec-fetch-site": "cross-site",
    });

    expect(res.status).toBe(200);
    expect(await rowCount(email)).toBe(0);
  });

  it("Pressing the button on the page unsubscribes, from the same origin", async () => {
    const { email, token } = await mailedAddress("button");

    const res = await fetchW(link(token), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://rarepair.fans",
        "sec-fetch-site": "same-origin",
      },
      body: "",
    });

    expect(res.status).toBe(200);
    expect(await rowCount(email)).toBe(0);
  });

  it("A second POST, or a token with no row, still answers 200 and says the same thing", async () => {
    const { token } = await mailedAddress("twice");
    const first = await providerPost(token);

    const again = await providerPost(token);
    const never = await providerPost(newToken());

    expect(again.status).toBe(200);
    expect(never.status).toBe(200);
    expect(await again.text()).toBe(await first.text());
    expect(await never.text()).toContain("You&#39;re unsubscribed");
  });

  it("The unsubscribe POST reads the token from the URL only: a token in the body deletes nothing", async () => {
    const { email, token } = await mailedAddress("body");

    const res = await fetchW(`/waitlist/unsubscribe?token=${newToken()}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });

    expect(res.status).toBe(200);
    expect(await rowCount(email)).toBe(1);
  });

  it("A confirmation token does not unsubscribe: only the unsubscribe token's hash is looked up", async () => {
    const email = `confirming-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const confirmToken = newToken();
    await db
      .insertInto("waitlist")
      .values({ email, confirm_token_hash: await hashToken(confirmToken) })
      .execute();

    const res = await providerPost(confirmToken);

    expect(res.status).toBe(200);
    expect(await rowCount(email)).toBe(1);
  });

  it("Nothing in the logs shows the address or the token", async () => {
    const { email, token } = await mailedAddress("logs");

    const logged = await consoleDuring(async () => {
      await fetchW(link(token));
      await providerPost(token);
      await providerPost(token);
    });

    const text = logged.join("\n");
    expect(text).not.toContain(email);
    expect(text).not.toContain(token);
  });
});
