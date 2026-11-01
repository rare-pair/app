import { createDb } from "@archive/db";
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import {
  emailsTo,
  fetchW,
  LOGIN_TOKEN,
  postLogin,
  REMOVE_TOKEN,
  signIn,
  UPLOAD_TOKEN,
  WAITLIST_TOKEN,
} from "./helpers";

// Each form's Turnstile widget names its action, and the Worker accepts a token only under
// that action (ARCHITECTURE, Surge controls). vitest.config.ts's siteverify stand-in reports
// the action after the "#" of a token, as Cloudflare reports the one the widget set.
// The wait list form is covered in 23-turnstile-action.prelaunch.test.ts.

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** The `data-action` of every Turnstile widget in a page. */
const actionsIn = (html: string) =>
  [...html.matchAll(/<div class="cf-turnstile"[^>]*>/g)].map(
    (tag) => tag[0].match(/\sdata-action="([^"]*)"/)?.[1],
  );

describe("23-turnstile-action", () => {
  it("Each form's widget names its action", async () => {
    expect(actionsIn(await (await fetchW("/login")).text())).toEqual(["login"]);

    const cookie = await signIn("action-markup@example.test", { acceptTerms: true });
    const upload = await fetchW("/upload", { headers: { cookie } });
    expect(actionsIn(await upload.text())).toEqual(["upload"]);

    expect(actionsIn(await (await fetchW("/remove")).text())).toEqual(["remove"]);
  });

  it("A token solved on another form is refused by removal requests", async () => {
    const email = "action-remove@example.test";
    for (const token of [LOGIN_TOKEN, WAITLIST_TOKEN, UPLOAD_TOKEN, "XXXX.DUMMY.TOKEN.XXXX"]) {
      const res = await postLogin(
        { email, pseud: "action-remove pseud", "cf-turnstile-response": token },
        { url: "/remove" },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("The anti-spam check did not pass.");
    }
    const stored = () =>
      db.selectFrom("requests").select("id").where("contact_email", "=", email).execute();
    expect(await stored()).toEqual([]);
    // Its own token passes.
    const own = await postLogin(
      { email, pseud: "action-remove pseud", "cf-turnstile-response": REMOVE_TOKEN },
      { url: "/remove" },
    );
    expect(own.status).toBe(200);
    expect(await stored()).toHaveLength(1);
  });

  it("A token solved on another form is refused by sign-in", async () => {
    const email = "action-login@example.test";
    for (const token of [WAITLIST_TOKEN, UPLOAD_TOKEN, "XXXX.DUMMY.TOKEN.XXXX"]) {
      const res = await postLogin({ email, "cf-turnstile-response": token });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("The anti-spam check did not pass.");
    }
    // The refusals sent nothing; its own token does.
    expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
    expect(await emailsTo(email, { atLeast: 1 })).toHaveLength(1);
  });

  it("A token solved on another form is refused by upload requests", async () => {
    const email = "action-upload@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    const user = await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    const uploads = () =>
      db.selectFrom("uploads").select("id").where("user_id", "=", user.id).execute();

    for (const token of [LOGIN_TOKEN, WAITLIST_TOKEN, "XXXX.DUMMY.TOKEN.XXXX"]) {
      const res = await postLogin(
        { size: "1000", "cf-turnstile-response": token },
        { url: "/uploads", headers: { cookie } },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await uploads()).toEqual([]);

    const ok = await postLogin(
      { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN },
      { url: "/uploads", headers: { cookie } },
    );
    expect(ok.status).toBe(200);
    expect(await uploads()).toHaveLength(1);
  });
});
