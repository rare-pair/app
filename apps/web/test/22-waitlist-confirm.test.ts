import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/waitlist";
import { BASE, fetchW, STRICT, withoutNonce } from "./helpers";

// Runs in the "open" project (PRELAUNCH off): an old confirmation link says the archive is open.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const HSTS = "max-age=31536000; includeSubDomains";

/** A token shaped like the ones the join form issues: 43 base64url characters. */
const newToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** An unconfirmed address whose confirmation email went out a minute ago. Returns its token. */
async function pendingAddress(name: string) {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const token = newToken();
  await db
    .insertInto("waitlist")
    .values({
      email,
      confirm_token_hash: await hashToken(token),
      confirm_sent_at: new Date(Date.now() - 60_000),
    })
    .execute();
  return { email, token };
}

const confirmedAt = async (email: string) =>
  (
    await db
      .selectFrom("waitlist")
      .select("confirmed_at")
      .where("email", "=", email)
      .executeTakeFirstOrThrow()
  ).confirmed_at;

async function expectArchiveOpen(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("strict-transport-security")).toBe(HSTS);
  expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
  expect(res.headers.get("set-cookie")).toBeNull();
  const html = await res.text();
  expect(html).toMatch(/archive is open/i);
  expect(html).toMatch(/<a[^>]*href="\/"/);
  expect(html).not.toMatch(/<form|<script|cf-turnstile/i);
}

describe("22-waitlist after launch", () => {
  it("An old confirmation link says the archive is open and confirms nothing", async () => {
    const { email, token } = await pendingAddress("old-link");

    await expectArchiveOpen(await fetchW(`/waitlist/confirm?token=${encodeURIComponent(token)}`));
    const posted = await fetchW("/waitlist/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ token }).toString(),
    });
    await expectArchiveOpen(posted);

    expect(await confirmedAt(email)).toBeNull();
  });

  it("An old confirmation link says the archive is open: with no token, or from another site", async () => {
    await expectArchiveOpen(await fetchW("/waitlist/confirm"));
    await expectArchiveOpen(await fetchW("/waitlist/confirm?token=nonsense"));
    await expectArchiveOpen(
      await fetchW("/waitlist/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://elsewhere.example.test",
          "sec-fetch-site": "cross-site",
        },
        body: "token=x",
      }),
    );
  });
});
