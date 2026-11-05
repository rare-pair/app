import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { useJourneySite } from "../harness/journey";
import { signedIn, signInLink } from "../harness/sessions";
import { SITE, type Site } from "../harness/site";
import { byAddress, startAtHome, viaHeader } from "../harness/walk";

// A reader signs in through the real pages: the form, the emailed link, the terms for a new
// account, and the pages a refused link or a limited address sees. Handler cases (the 403 on a
// cross-site POST, `next` reduction, what a token spends) are apps/web/test/01-*; this is what
// only a browser shows. Each journey opens one page, so it leaves one recording, and each uses
// addresses of its own: the sign-in form allows three requests a minute for one address.

/** Fills the sign-in form at `/login` (or the page's own redirect) and sends it. */
async function requestLink(page: Page, email: string): Promise<void> {
  await page.getByLabel("Email address").fill(email);
  // Wait for the load before the click, never after: a delay can pass the event by.
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Email me a sign-in link" }).click(),
  ]);
}

/** Opens the emailed link. */
async function openLink(page: Page, link: string): Promise<void> {
  // The emailed link is a full address on the site; byAddress takes its path.
  const { origin, pathname, search } = new URL(link);
  expect(origin).toBe(SITE);
  await byAddress(page, `${pathname}${search}`, "an emailed sign-in link opens as an address");
}

/** Opens the emailed link in the browser that asked for it: the page goes on by itself. */
async function followLink(page: Page, link: string): Promise<void> {
  await openLink(page, link);
  await page.waitForURL((url) => url.pathname !== "/login/confirm");
}

/** Opens the emailed link in a browser without the marker, and presses its Sign in button. */
async function followLinkWithPress(page: Page, link: string): Promise<void> {
  await openLink(page, link);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
}

/** LOGIN_EMAIL_LIMIT's window, as wrangler.jsonc sets it. */
function emailLimitPeriodSeconds(): number {
  const { ratelimits } = unstable_readConfig(
    { config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)) },
    { hideWarnings: true },
  );
  const period = ratelimits.find((r: { name: string }) => r.name === "LOGIN_EMAIL_LIMIT")?.simple
    .period;
  if (period === undefined) throw new Error("wrangler.jsonc has no LOGIN_EMAIL_LIMIT");
  return period;
}

/**
 * Waits until the limiter's window has at least `leftMs` left. Its windows are fixed and aligned
 * to the clock, so the four sends must all land in one: the browser's leg runs several seconds
 * while recording (slowMo).
 */
async function inFreshWindow(leftMs: number): Promise<void> {
  const windowMs = emailLimitPeriodSeconds() * 1000;
  const left = windowMs - (Date.now() % windowMs);
  if (left < leftMs) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

async function ageLinks(site: Site, email: string): Promise<void> {
  await site.db
    .updateTable("verification")
    .set({ expires_at: new Date(Date.now() - 60_000) })
    .where("value", "like", `%${JSON.stringify(email)}%`)
    .execute();
}

const REFUSED = "That sign-in link was used or has expired. Request a new one.";

describe("sign-in journey", () => {
  const running = useJourneySite();

  it("A new account signs in, accepts the terms and lands on the page it came from", async () => {
    const { site } = running;
    const email = "pw1-new@example.test";
    const page = await startAtHome(await site.newContext());

    // Signed out, the header's Add work link sends a person to sign in first.
    await viaHeader(page, "Add work");
    await expect.poll(() => page.url()).toBe(`${SITE}/login?next=%2Fupload`);
    await requestLink(page, email);
    await page.getByText("Check your email").waitFor();

    await followLink(page, await signInLink(site, email));
    await expect.poll(() => page.url()).toBe(`${SITE}/welcome/terms?next=%2Fupload`);
    await page.getByText("Before you start").waitFor();

    await page.getByRole("button", { name: "I accept the terms" }).click();
    await expect.poll(() => page.url()).toBe(`${SITE}/upload`);
    await page.getByRole("heading", { name: "Upload a work" }).waitFor();
    const user = await site.db
      .selectFrom("user")
      .select("terms_accepted_at")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    expect(user.terms_accepted_at).not.toBeNull();
  });

  it("The browser that asked for the link signs in without a press, and another browser sees the button", async () => {
    const { site } = running;
    const email = "pw1-no-press@example.test";
    const context = await site.newContext();
    const page = await startAtHome(context);

    await viaHeader(page, "Sign in");
    await requestLink(page, email);
    await page.getByText("Check your email").waitFor();
    const link = await signInLink(site, email);
    const tokens = () =>
      site.db
        .selectFrom("verification")
        .select("id")
        .where("value", "like", `%${JSON.stringify(email)}%`)
        .execute();
    const issued = await tokens();
    expect(issued).toHaveLength(1);

    // A second browser, which didn't ask: the button, and nothing spent. Only looked at.
    const other = await (await site.newContext()).newPage();
    site.dropRecording(other);
    await openLink(other, link);
    await other.getByRole("button", { name: "Sign in" }).waitFor();
    expect(other.url()).toContain("/login/confirm");
    expect(await tokens()).toEqual(issued);
    await other.close();

    // The browser that asked: nothing is pressed here. A new account goes on to the terms.
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
    });
    await followLink(page, link);
    await expect.poll(() => page.url()).toBe(`${SITE}/welcome/terms?next=%2F`);
    expect(posts).toEqual(["/login/confirm"]);
    expect(await tokens()).toEqual([]);
    await page.getByRole("banner").getByRole("button", { name: "Sign out" }).waitFor();

    // The marker went with the answer, so the link's page, opened again, posts nothing by itself.
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain(
      "__Host-signin-pending",
    );
    await openLink(page, link);
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    expect(posts).toEqual(["/login/confirm"]);
  });

  it("A returning account skips the terms and its session survives a reload and a new tab", async () => {
    const { site } = running;
    const email = "pw1-returning@example.test";
    // The account exists, with its terms accepted; the journey signs it in again.
    const first = await signedIn(site, { email });
    await first.context.close();
    const context = await site.newContext();
    const page = await startAtHome(context);

    await viaHeader(page, "Add work");
    // signInLink returns the newest email, and the first sign-in's is already there: wait for
    // the one this request queues.
    const signIns = async () =>
      (await site.emails()).filter((m) => m.kind === "sign-in" && m.to === email).length;
    const sent = await signIns();
    await requestLink(page, email);
    await expect.poll(signIns).toBeGreaterThan(sent);
    await followLink(page, await signInLink(site, email));
    await expect.poll(() => page.url()).toBe(`${SITE}/upload`);
    await page.getByRole("heading", { name: "Upload a work" }).waitFor();

    await page.reload();
    await expect.poll(() => page.url()).toBe(`${SITE}/upload`);
    await page.getByRole("heading", { name: "Upload a work" }).waitFor();

    // A second page would make a second video: this one is only looked at, not recorded.
    const tab = await startAtHome(context);
    site.dropRecording(tab);
    await viaHeader(tab, "Add work");
    await expect.poll(() => tab.url()).toBe(`${SITE}/upload`);
    await tab.getByRole("heading", { name: "Upload a work" }).waitFor();
    await tab.close();
  });

  // The header's Sign out, from the home page: it ends the session in the browser (#554,
  // #568). This was the known failure that marked it; the header's control makes it pass.
  it("Sign-out ends the session in the browser", async () => {
    const { site } = running;
    const { context } = await signedIn(site, { email: "pw1-signout@example.test" });
    const page = await startAtHome(context);
    await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => page.url()).toBe(`${SITE}/`);
    await page.getByRole("banner").getByRole("link", { name: "Sign in" }).waitFor();
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain(
      "__Secure-better-auth.session_token",
    );
    // Signed out again, the header shows Add work, and it asks to sign in.
    await viaHeader(page, "Add work");
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  it("A used link shows the refused-link page", async () => {
    const { site } = running;
    const email = "pw1-used@example.test";
    const page = await startAtHome(await site.newContext());

    await viaHeader(page, "Sign in");
    await requestLink(page, email);
    const link = await signInLink(site, email);
    await followLink(page, link);
    await expect.poll(() => page.url()).toBe(`${SITE}/welcome/terms?next=%2F`);

    // The same link again, with the marker gone: GET shows its button, and pressing it is refused.
    await followLinkWithPress(page, link);
    await expect.poll(() => page.url()).toBe(`${SITE}/login?error=INVALID_TOKEN`);
    await expect.poll(() => page.getByRole("alert").innerText()).toBe(REFUSED);
  });

  it("An expired link shows the refused-link page", async () => {
    const { site } = running;
    const email = "pw1-expired@example.test";
    const page = await startAtHome(await site.newContext());

    await viaHeader(page, "Sign in");
    await requestLink(page, email);
    const link = await signInLink(site, email);
    await ageLinks(site, email);
    await followLink(page, link);
    await expect.poll(() => page.url()).toBe(`${SITE}/login?error=INVALID_TOKEN`);
    await expect.poll(() => page.getByRole("alert").innerText()).toBe(REFUSED);
  });

  it("An address over the sign-in limit sees the too-many-requests page", async () => {
    const { site } = running;
    const email = "pw1-limited@example.test";
    // Three requests a minute for one address; the fourth must land in the same window.
    await inFreshWindow(30_000);
    const page = await startAtHome(await site.newContext());
    for (let i = 0; i < 3; i += 1) {
      await viaHeader(page, "Sign in");
      await requestLink(page, email);
      await page.getByText("Check your email").waitFor();
    }
    await viaHeader(page, "Sign in");
    await requestLink(page, email);
    await page.getByRole("heading", { name: "Too many requests" }).waitFor();
    // Chromium logs the page's own 429 as a console error.
    await site.assertClean({ allow: [/status of 429/] });
  });
});
