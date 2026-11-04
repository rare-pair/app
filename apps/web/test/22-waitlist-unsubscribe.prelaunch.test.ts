import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/waitlist";
import { fetchW } from "./helpers";

// Runs in the "prelaunch" project: PRELAUNCH on. /waitlist and everything under it is open
// before launch, so the link in a launch email works the same.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

// 43 base64url characters, as issued, fresh each run: the hash column is unique.
const TOKEN = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");

describe("22-waitlist", () => {
  it("The unsubscribe link works with PRELAUNCH on", async () => {
    const email = `prelaunch-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await db
      .insertInto("waitlist")
      .values({ email, unsubscribe_token_hash: await hashToken(TOKEN) })
      .execute();

    const page = await fetchW(`/waitlist/unsubscribe?token=${TOKEN}`);
    const res = await fetchW(`/waitlist/unsubscribe?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });

    expect(TOKEN).toHaveLength(43);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Unsubscribe</button>");
    expect(res.status).toBe(200);
    const left = await db
      .selectFrom("waitlist")
      .select("email")
      .where("email", "=", email)
      .execute();
    expect(left).toEqual([]);
  });
});
