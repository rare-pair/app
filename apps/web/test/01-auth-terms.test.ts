import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptTerms,
  BASE,
  emailsTo,
  fetchW,
  nonceOf,
  LOGIN_TOKEN,
  UPLOAD_TOKEN,
  postLogin,
  signIn,
  STRICT,
  withoutNonce,
} from "./helpers";

// The terms gate (A4): a signed-in account that hasn't accepted the terms is sent to
// /welcome/terms first. One database serves every test file in the run, so this file
// keeps to AO3 work IDs 13000 to 13099 and finds its rows by address.

const WORK = 13000;
const WORK_PAGE = `/works/${WORK}`;

// The site chrome test's check: names only as provenance, never in the page.
const BRANDING = /AO3|OTW|Archive of Our Own|Organization for Transformative Works/i;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  await seedWork(db, { ao3WorkId: WORK, title: "a4 Work" });
});
afterAll(() => db.destroy());

/** A request to the Worker with `cookie`, a GET unless `method` says otherwise. */
const get = (path: string, cookie: string, method = "GET") =>
  fetchW(path, { method, headers: { cookie } });

/** The account's `terms_accepted_at`. */
const termsAcceptedAt = async (email: string) =>
  (
    await db
      .selectFrom("user")
      .select("terms_accepted_at")
      .where("email", "=", email)
      .executeTakeFirstOrThrow()
  ).terms_accepted_at;

/** Where a redirect goes, as a URL on the site. */
const locationOf = (res: Response) => new URL(res.headers.get("location") ?? "", BASE);

/** The `next` the terms page's form carries, as it stands in the markup. */
const hiddenNextOf = (html: string) =>
  html.match(/<input type="hidden" name="next" value="([^"]*)">/)?.[1];

/** Shows `res` sends the account to the terms page, to come back to `next`. */
function expectTermsRedirect(res: Response, next: string) {
  expect(res.status).toBe(302);
  const location = locationOf(res);
  expect(location.origin).toBe(BASE);
  expect(location.pathname).toBe("/welcome/terms");
  expect(location.searchParams.get("next")).toBe(next);
}

describe("01-auth-magic-link", () => {
  it("New account must accept the terms before continuing", async () => {
    const email = "terms-new@example.test";
    const cookie = await signIn(email, { next: WORK_PAGE });

    const gated = await get(WORK_PAGE, cookie);
    expectTermsRedirect(gated, WORK_PAGE);
    // The terms page, as the redirect opens it, carries the work page on.
    const page = await (await get(gated.headers.get("location")!, cookie)).text();
    const next = hiddenNextOf(page)!;
    expect(next).toBe(WORK_PAGE);
    expect(await termsAcceptedAt(email)).toBeNull();

    const accepted = await acceptTerms(cookie, next);
    expect(accepted.headers.get("location")).toBe(WORK_PAGE);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await termsAcceptedAt(email)).toBeInstanceOf(Date);
    const work = await get(WORK_PAGE, cookie);
    expect(work.status).toBe(200);
    expect(await work.text()).toContain("a4 Work");
  });

  it("Accepting again keeps the first time", async () => {
    const email = "terms-twice@example.test";
    const cookie = await signIn(email, { acceptTerms: true });
    const first = await termsAcceptedAt(email);
    expect(first).toBeInstanceOf(Date);

    expect((await acceptTerms(cookie, WORK_PAGE)).headers.get("location")).toBe(WORK_PAGE);
    expect(await termsAcceptedAt(email)).toEqual(first);
  });

  it("Accepting refuses a cross-site post, and keeps only a same-site next", async () => {
    const email = "terms-refusals@example.test";
    const cookie = await signIn(email);
    const post = (headers: Record<string, string>, next = WORK_PAGE) =>
      postLogin({ next }, { url: "/welcome/terms", headers: { cookie, ...headers } });

    // Each over the headers a browser on the site sends.
    const crossSite: Record<string, string>[] = [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://content.rarepair.fans", "sec-fetch-site": "same-site" },
    ];
    for (const headers of crossSite) {
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await termsAcceptedAt(email)).toBeNull();
    }
    // A form with neither header, as no browser posts one.
    const bare = await fetchW("/welcome/terms", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "next=%2F",
    });
    expect(bare.status).toBe(403);
    expect(await termsAcceptedAt(email)).toBeNull();

    for (const next of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "/welcome/terms",
    ]) {
      const res = await post({}, next);
      expect(res.status, next).toBe(303);
      expect(res.headers.get("location"), next).toBe("/");
    }
    expect(await termsAcceptedAt(email)).toBeInstanceOf(Date);
  });

  it("Before accepting, every other page and method goes to the terms page", async () => {
    const cookie = await signIn("terms-every-page@example.test");

    for (const path of ["/", "/upload", "/nope", "/works/13000?x=1", "/works/13000/report"]) {
      const res = await get(path, cookie);
      expectTermsRedirect(res, path);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
    }
    expectTermsRedirect(await get(WORK_PAGE, cookie, "HEAD"), WORK_PAGE);
    // A form post is no page to come back to.
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await get("/waitlist", cookie, method);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/welcome/terms");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("Before accepting, the terms, privacy, about, removal and sign-in pages and static files still open", async () => {
    const cookie = await signIn("terms-exempt@example.test");

    for (const path of [
      "/terms",
      "/privacy",
      "/about",
      "/remove",
      "/login",
      "/login/confirm?token=x",
    ]) {
      const res = await get(path, cookie);
      expect(res.status, path).toBe(200);
    }
    // Anyone can ask for a removal: below /remove is not sent to the terms page either.
    expect((await get("/remove/x", cookie)).headers.get("location")).toBeNull();
    // The stylesheet every page links to, the terms page's own included.
    const page = await (await get("/terms", cookie)).text();
    const stylesheet = page.match(/<link rel="stylesheet" href="([^"]+)"/)![1]!;
    const css = await get(stylesheet, cookie);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
  });

  it("A signed-out visitor, or a forged cookie, is never sent to the terms page", async () => {
    for (const path of ["/about", "/terms", WORK_PAGE]) {
      expect((await fetchW(path)).status, path).toBe(200);
      const forged = await get(path, "__Secure-better-auth.session_token=forged.value");
      expect(forged.status, path).toBe(200);
    }
  });

  it("The terms page is a no-script form to accept, linking to the terms", async () => {
    const cookie = await signIn("terms-page@example.test");

    const res = await get(`/welcome/terms?next=${encodeURIComponent(WORK_PAGE)}`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy");
    expect(withoutNonce(csp)).toBe(STRICT);
    expect(nonceOf(csp)).not.toBe(
      nonceOf((await get("/welcome/terms", cookie)).headers.get("content-security-policy")),
    );
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/<form method="post" action="\/welcome\/terms">/);
    expect(html).toContain(`<input type="hidden" name="next" value="${WORK_PAGE}">`);
    expect(html).toMatch(/<button type="submit">[^<]+<\/button>/);
    expect(html).toContain('<a href="/terms">');
    expect(html).toContain('<p class="draft">');
    expect(html).not.toMatch(BRANDING);
  });

  it("The terms page keeps only a same-site next, escaped", async () => {
    const cookie = await signIn("terms-page-next@example.test");
    const hiddenNext = async (next: string) =>
      hiddenNextOf(
        await (await get(`/welcome/terms?next=${encodeURIComponent(next)}`, cookie)).text(),
      );

    for (const next of ["https://evil.example/", "//evil.example", "/\\evil.example", ""]) {
      expect(await hiddenNext(next), next).toBe("/");
    }
    // Never the terms page itself: its own next instead, one level deep.
    expect(await hiddenNext("/welcome/terms?next=/works/1")).toBe("/works/1");
    expect(await hiddenNext("/welcome/terms?next=/welcome/terms?next=/works/1")).toBe("/");
    expect(await hiddenNext("/welcome/terms?next=https://evil.example/")).toBe("/");
    expect(await hiddenNext(`/works/1?q="'<>&`)).toBe("/works/1?q=%22%27%3C%3E&amp;");
  });

  it("Signed out, the terms page sends to sign in and back", async () => {
    const page = `/welcome/terms?next=${encodeURIComponent(WORK_PAGE)}`;
    const res = await fetchW(page);
    expect(res.status).toBe(302);
    const location = locationOf(res);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(page);

    // A post too, carrying the page it was posted to (ARCHITECTURE, Auth).
    const post = await postLogin({ next: WORK_PAGE }, { url: "/welcome/terms" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/login?next=%2Fwelcome%2Fterms");
    // The origin is checked first, signed in or not, as on the sign-in forms.
    const crossSite = await postLogin(
      { next: WORK_PAGE },
      { url: "/welcome/terms", headers: { origin: "https://evil.example" } },
    );
    expect(crossSite.status).toBe(403);
  });

  it("Once accepted, the terms page goes straight to next", async () => {
    const cookie = await signIn("terms-accepted-bookmark@example.test", { acceptTerms: true });
    const from = async (next: string) => {
      const res = await get(`/welcome/terms?next=${encodeURIComponent(next)}`, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.headers.get("location");
    };

    expect(await from(WORK_PAGE)).toBe(WORK_PAGE);
    expect(await from("https://evil.example/")).toBe("/");
    expect(await from("/welcome/terms")).toBe("/");
    // As signing in from the terms page leaves it: on to the page it carried.
    expect(await from(`/welcome/terms?next=${encodeURIComponent(WORK_PAGE)}`)).toBe(WORK_PAGE);
  });

  it("Before accepting, /admin answers its own 404, as for any other non-moderator", async () => {
    const cookie = await signIn("terms-admin@example.test");
    const notFound = await (await fetchW("/nope")).text();

    for (const path of ["/admin", "/admin/reports"]) {
      const res = await get(path, cookie);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toBe(notFound);
    }

    // A moderator who hasn't accepted the terms still reaches /admin.
    const moderator = "terms-moderator@example.test";
    const modCookie = await signIn(moderator);
    await db
      .updateTable("user")
      .set({ role: "moderator" })
      .where("email", "=", moderator)
      .execute();
    expect((await get("/admin", modCookie)).status).toBe(200);
    expect(await termsAcceptedAt(moderator)).toBeNull();
  });

  it("Before accepting, a report form post goes to the terms page and stores nothing", async () => {
    const email = "terms-report@example.test";
    const cookie = await signIn(email);
    const report = (headers: Record<string, string> = {}) =>
      postLogin(
        { kind: "wrong_version", body: "" },
        { url: `${WORK_PAGE}/report`, headers: { cookie, ...headers } },
      );

    const res = await report();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/welcome/terms");
    // Cross-site is refused first, before the session and the gate.
    expect((await report({ origin: "https://evil.example" })).status).toBe(403);

    const reports = await db
      .selectFrom("reports")
      .innerJoin("user", "user.id", "reports.reporter_id")
      .select("reports.id")
      .where("user.email", "=", email)
      .execute();
    expect(reports).toEqual([]);
  });

  it("Before accepting, an upload request gets no row and no URL", async () => {
    const email = "terms-upload@example.test";
    const cookie = await signIn(email);
    const fields = { size: "1000", "cf-turnstile-response": UPLOAD_TOKEN };

    // The upload page's script can't follow a redirect, so it gets a 401 to act on.
    const res = await postLogin(fields, { url: "/uploads", headers: { cookie } });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // SAFETY: the refusal is JSON, as POST /uploads's own are.
    const body = (await res.json()) as { error?: string };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toMatch(/terms/);
    // Cross-site is still refused first, as the upload page's script expects.
    const crossSite = await postLogin(fields, {
      url: "/uploads",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("content-type")).toMatch(/^application\/json/);

    const uploads = await db
      .selectFrom("uploads")
      .innerJoin("user", "user.id", "uploads.user_id")
      .select("uploads.id")
      .where("user.email", "=", email)
      .execute();
    expect(uploads).toEqual([]);
  });

  it("Returning user skips the terms page", async () => {
    const email = "terms-returning@example.test";
    await signIn(email);
    // An existing account, its terms accepted some time ago.
    await db
      .updateTable("user")
      .set({ terms_accepted_at: new Date("2026-09-01T00:00:00Z") })
      .where("email", "=", email)
      .execute();

    // Signing in again through a new emailed link, from the work page.
    expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
    const sent = await emailsTo(email, { atLeast: 2 });
    const token = new URL(sent.at(-1)!.url).searchParams.get("token")!;
    const confirmed = await postLogin({ token, next: WORK_PAGE }, { url: "/login/confirm" });
    expect(confirmed.status).toBe(303);
    expect(locationOf(confirmed).href).toBe(`${BASE}${WORK_PAGE}`);

    const cookie = confirmed.headers.getSetCookie()[0]!.split(";")[0]!;
    const page = await get(WORK_PAGE, cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("a4 Work");
  });
});
