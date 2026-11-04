import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { emailsTo, fetchW, LOGIN_TOKEN, postLogin } from "./helpers";

// /admin is open before launch (ARCHITECTURE, Wait list), so the operator can
// moderate then: the gate, not the coming-soon redirect, decides. Text is synthetic.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs `email` in through the Worker with `role`, and returns its session cookie. A4 (#24) brings the shared one. */
async function signIn(email: string, role: string | null): Promise<string> {
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const [sent] = await emailsTo(email);
  const token = new URL(sent!.url).searchParams.get("token")!;
  const res = await postLogin({ token, next: "/" }, { url: "/login/confirm" });
  expect(res.status).toBe(303);
  await db
    .updateTable("user")
    .set({ role, terms_accepted_at: new Date() })
    .where("email", "=", email)
    .execute();
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

describe("18 moderation before launch", () => {
  it("A moderator sees the queues before launch", async () => {
    const cookie = await signIn("mod1-prelaunch-moderator@example.test", "moderator");
    const res = await fetchW("/admin/reports", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("Anyone else gets the not-found page before launch, not the coming-soon redirect", async () => {
    // GET /waitlist answers the not-found page before launch.
    const control = await fetchW("/waitlist");
    expect(control.status).toBe(404);
    const notFound = await control.text();
    const user = await signIn("mod1-prelaunch-user@example.test", "user");
    for (const cookie of [undefined, user]) {
      const res = await fetchW(
        "/admin/reports",
        cookie === undefined ? {} : { headers: { cookie } },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(notFound);
    }
  });
});
