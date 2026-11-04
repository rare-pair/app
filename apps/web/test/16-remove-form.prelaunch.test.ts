import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { postLogin, REMOVE_TOKEN } from "./helpers";

// Before launch /remove is closed like every page but the coming-soon page: the form and a
// post both go home, and a post stores nothing. 20-closed-links.prelaunch covers the
// disabled footer link and the GET.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

describe("16-removal-and-opt-out, before launch", () => {
  it("A removal request posted before launch goes to the coming-soon page and stores nothing", async () => {
    const email = "x1-prelaunch@example.test";
    const res = await postLogin(
      { email, pseud: "x1 prelaunch pseud", "cf-turnstile-response": REMOVE_TOKEN },
      { url: "/remove" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const stored = await db
      .selectFrom("requests")
      .select("id")
      .where("contact_email", "=", email)
      .execute();
    expect(stored).toEqual([]);
  });
});
