import { describe, expect, it } from "vitest";
import { useJourneySite } from "../harness/journey";
import { signedIn } from "../harness/sessions";
import { SITE } from "../harness/site";
import { byAddress, startAtHome, viaHeader } from "../harness/walk";

// A reader signs out with the button on /logout, in a real browser with JavaScript off. What the
// Worker answers (the row, the cookie's flags, the 403 on a cross-site POST, Clear-Site-Data) is
// apps/web/test/01-auth-sign-out. The browser's cache is not checked here: Playwright turns the
// HTTP cache off in a context with routes, as the harness's has, and the harness's certificate is
// self-signed, so a cached page can't be told from a fetched one. This journey presses the sign-out
// page's own button, by its URL; the header's control is pressed from the home page in signin.

describe("sign-out journey", () => {
  const running = useJourneySite();

  it("The sign-out button works without JavaScript", async () => {
    const { site } = running;
    // Signing in needs the sign-in page's script (Turnstile); the session then moves to a
    // browser with JavaScript off, which is where sign-out has to work too.
    const signed = await signedIn(site, { email: "out-journey@example.test" });
    const context = await site.newContext({ javaScript: false });
    await context.addCookies(await signed.context.cookies());
    const session = "__Secure-better-auth.session_token";
    expect((await context.cookies()).map((cookie) => cookie.name)).toContain(session);
    const page = await startAtHome(context);
    await viaHeader(page, "My uploads");
    expect(new URL(page.url()).pathname).toBe("/me/uploads");

    await byAddress(
      page,
      "/logout",
      "the sign-out page has no link; the header's Sign out is a button that posts, and this journey presses the page's own button",
    );
    await Promise.all([
      page.waitForURL(`${SITE}/`),
      // The page's own button: the header has one too, which the other journey presses.
      page.locator("main").getByRole("button", { name: "Sign out" }).click(),
    ]);

    // Signed out: the sign-out page says so, and a page that needs an account asks to sign in.
    await byAddress(
      page,
      "/logout",
      "a typed or bookmarked address; the sign-out page has no link",
    );
    expect(await page.locator("body").innerText()).toContain("You are not signed in");
    await byAddress(
      page,
      "/me/uploads",
      "a signed-out person has no My uploads link (the header hides it); this is a bookmark",
    );
    expect(new URL(page.url()).pathname).toBe("/login");
    const names = (await context.cookies()).map((cookie) => cookie.name);
    expect(names).not.toContain(session);
  });
});
