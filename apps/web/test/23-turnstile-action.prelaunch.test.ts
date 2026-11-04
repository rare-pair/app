import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { BASE, fetchW, freshIp, LOGIN_TOKEN, UPLOAD_TOKEN, WAITLIST_TOKEN } from "./helpers";

// The wait list form's half of 23-turnstile-action.test.ts. Runs in the "prelaunch"
// project, where the form is wanted.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const join = (email: string, token: string) =>
  fetchW("/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": freshIp(),
    },
    body: new URLSearchParams({ email, "cf-turnstile-response": token }).toString(),
  });

const rowOf = (email: string) =>
  db.selectFrom("waitlist").selectAll().where("email", "=", email).executeTakeFirst();

describe("23-turnstile-action", () => {
  it("The wait list widget names its action", async () => {
    const widget = (html: string) => html.match(/<div class="cf-turnstile"[^>]*>/)?.[0];
    expect(widget(await (await fetchW("/")).text())).toMatch(/\sdata-action="waitlist"/);
    // The form again, after a refusal.
    const again = await join("again@example.test", "not-a-token");
    expect(widget(await again.text())).toMatch(/\sdata-action="waitlist"/);
  });

  it("A token solved on another form is refused by the wait list", async () => {
    const email = `action-${crypto.randomUUID().slice(0, 8)}@example.test`;
    for (const token of [LOGIN_TOKEN, UPLOAD_TOKEN, "XXXX.DUMMY.TOKEN.XXXX"]) {
      const res = await join(email, token);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("The anti-spam check did not pass.");
      expect(await rowOf(email)).toBeUndefined();
    }
    expect((await join(email, WAITLIST_TOKEN)).status).toBe(200);
    expect(await rowOf(email)).toBeDefined();
  });
});
