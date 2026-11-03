import type { RequestInit } from "miniflare";
import type { BrowserContext } from "playwright";
import { freshIp, SITE, type ContextOptions, type Site } from "./site";

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

// The siteverify stand-in passes Cloudflare's dummy token solved under the form's action
// (test/stand-ins.ts).
const LOGIN_TOKEN = "XXXX.DUMMY.TOKEN.XXXX#login";
// src/auth.ts's SESSION_COOKIE. Not imported: that module brings Better Auth and the Workers
// types with it. Were it renamed, signing in would fail here, finding no session cookie.
const SESSION_COOKIE = "__Secure-better-auth.session_token";

/** A form POST as a browser on the site sends it, from a client address of its own. */
const formPost = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: SITE,
    "sec-fetch-site": "same-origin",
    "cf-connecting-ip": freshIp(),
  },
  body: new URLSearchParams(fields).toString(),
});

/** Waits up to 10 seconds for the newest sign-in email to `email`, and returns its link. */
async function signInLink(site: Site, email: string): Promise<string> {
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
 * Signs `account` in through the Worker, as the sign-in form and its emailed link do, sets
 * its role, and returns a browser context holding the session cookie the Worker issued,
 * with the flags it issued it with. Use a new email for each call: the sign-in form allows
 * three a minute for one address.
 */
export async function signedIn(
  site: Site,
  { email, role = "reader", acceptTerms = true }: Account,
  options: ContextOptions = {},
): Promise<SignedIn> {
  const asked = await site.fetch(
    "/login",
    formPost({ email, "cf-turnstile-response": LOGIN_TOKEN }),
  );
  if (asked.status !== 200) throw new Error(`POST /login for ${email}: ${asked.status}`);
  const token = new URL(await signInLink(site, email)).searchParams.get("token") ?? "";
  const confirmed = await site.fetch("/login/confirm", formPost({ token, next: "/" }));
  const value = confirmed.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (confirmed.status !== 303 || value === undefined) {
    throw new Error(`POST /login/confirm for ${email}: ${confirmed.status}, no session cookie`);
  }
  const user = await site.db
    .updateTable("user")
    .set({ role: role === "moderator" ? "moderator" : null })
    .$if(acceptTerms, (q) => q.set({ terms_accepted_at: new Date() }))
    .where("email", "=", email)
    .returning("id")
    .executeTakeFirstOrThrow();
  const context = await site.newContext(options);
  // As the Worker sets it (src/auth.ts): host-only (a `url`, not a domain), path /, Secure,
  // HttpOnly, SameSite=Lax.
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value,
      url: `${SITE}/`,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { context, userId: user.id };
}
