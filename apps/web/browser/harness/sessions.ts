import type { BrowserContext } from "playwright";
import { SITE, type ContextOptions, type Site } from "./site";

/**
 * Who a context is signed in as. A reader or an uploader is an ordinary account (an uploader
 * is one a suite gives uploads to); a moderator has the moderator role. Each has accepted
 * the terms unless `acceptTerms` is false: a new account, which every page but a few sends
 * to /welcome/terms.
 */
export type Account = {
  email: string;
  role?: "reader" | "uploader" | "moderator";
  acceptTerms?: boolean;
};

/** A signed-in browser context, and the account's user id for seeding its own rows. */
export type SignedIn = { context: BrowserContext; userId: string };

/** Waits up to 10 seconds for the newest sign-in email to `email`, and returns its link. */
export async function signInLink(site: Site, email: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const sent = (await site.emails()).filter((m) => m.kind === "sign-in" && m.to === email);
    const last = sent.at(-1);
    if (last !== undefined) return last.url;
    if (Date.now() > deadline) throw new Error(`no sign-in email to ${email} in 10 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Signs `account` in, in a new browser context, as a reader does: the sign-in form (its
 * Turnstile widget solved by the stand-in), then the emailed link's Sign in button. The
 * session cookie is the one the Worker set, with its own flags. Then sets the account's role
 * and, unless `acceptTerms` is false, accepts the terms for it. Use a new email for each
 * call: the sign-in form allows three a minute for one address.
 */
export async function signedIn(
  site: Site,
  { email, role = "reader", acceptTerms = true }: Account,
  options: ContextOptions = {},
): Promise<SignedIn> {
  const context = await site.newContext(options);
  const page = await context.newPage();
  try {
    await page.goto(`${SITE}/login`);
    await page.getByLabel("Email address").fill(email);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Email me a sign-in link" }).click(),
    ]);
    await page.goto(await signInLink(site, email));
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    // A refused link goes back to /login; a session goes on, to the terms for a new account.
    if (new URL(page.url()).pathname === "/login") {
      throw new Error(`signing ${email} in was refused: ${page.url()}`);
    }
  } finally {
    site.dropRecording(page);
    await page.close();
  }
  const user = await site.db
    .updateTable("user")
    .set({ role: role === "moderator" ? "moderator" : null })
    .$if(acceptTerms, (q) => q.set({ terms_accepted_at: new Date() }))
    .where("email", "=", email)
    .returning("id")
    .executeTakeFirstOrThrow();
  return { context, userId: user.id };
}
