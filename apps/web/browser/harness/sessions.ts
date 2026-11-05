import { createHmac, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { SECRETS } from "../../test/stand-ins";
import { SITE, type ContextOptions, type Site } from "./site";
import { viaHeader } from "./walk";

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
 * Signs `account` in, in a new browser context, as a reader does: from the home page, the
 * header's Sign in link, the sign-in form (its Turnstile widget solved by the stand-in), then
 * the emailed link's Sign in button. The session cookie is the one the Worker set, with its
 * own flags. Then sets the account's role and, unless `acceptTerms` is false, accepts the terms
 * for it. Use a new email for each call: the sign-in form allows three a minute for one address.
 */
export const signedIn = (site: Site, account: Account, options: ContextOptions = {}) =>
  // From a blank page, `viaHeader` begins at the home page.
  signIn(site, account, options, (page) => viaHeader(page, "Sign in"));

/**
 * `signedIn` for setup, which skips the link: it opens the sign-in page by its address. Use it
 * for an account a journey needs only to have, such as a second uploader or a reader who
 * looks at what the journey made, never for the journey's own way in.
 */
export const signedInDirect = (site: Site, account: Account, options: ContextOptions = {}) =>
  signIn(site, account, options, (page) => page.goto(`${SITE}/login`).then(() => undefined));

// src/auth.ts's SESSION_COOKIE. That module needs Workers' types, which this Node code hasn't. If
// the two differ, the accounts below aren't signed in and the before-launch suites fail.
const SESSION_COOKIE = "__Secure-better-auth.session_token";

/**
 * A session from before sign-in closed, for a site before launch, where no form can make one:
 * the account and session rows, and the cookie as Better Auth signs it.
 */
async function seededSession(
  site: Site,
  { email, role = "reader", acceptTerms = true }: Account,
  options: ContextOptions,
): Promise<SignedIn> {
  const userId = randomUUID();
  const token = randomUUID();
  await site.db
    .insertInto("user")
    .values({
      id: userId,
      name: "",
      email,
      email_verified: true,
      role: role === "moderator" ? "moderator" : null,
      terms_accepted_at: acceptTerms ? new Date() : null,
    })
    .execute();
  await site.db
    .insertInto("session")
    .values({
      id: randomUUID(),
      token,
      user_id: userId,
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
      updated_at: new Date(),
    })
    .execute();
  const signature = createHmac("sha256", SECRETS.BETTER_AUTH_SECRET).update(token).digest("base64");
  const context = await site.newContext(options);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: encodeURIComponent(`${token}.${signature}`),
      url: SITE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  return { context, userId };
}

async function signIn(
  site: Site,
  account: Account,
  options: ContextOptions,
  openSignIn: (page: Page) => Promise<void>,
): Promise<SignedIn> {
  if (site.prelaunch) return seededSession(site, account, options);
  const { email, role = "reader", acceptTerms = true } = account;
  const context = await site.newContext(options);
  const page = await context.newPage();
  try {
    await openSignIn(page);
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
