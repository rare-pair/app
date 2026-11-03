// The email queue's message contract. The web Worker produces it; the mailer consumes it.
// `from` is not part of it: the mailer sets it.
export interface SignInEmail {
  kind: "sign-in";
  to: string;
  url: string;
}

/** The wait list's double opt-in email (ARCHITECTURE, Wait list). */
export interface WaitlistConfirmEmail {
  kind: "waitlist-confirm";
  to: string;
  url: string;
}

/**
 * The removal request's confirmation email (ARCHITECTURE, Author requests & takedowns). The
 * link confirms a removal request or opt-out; the message names neither the work nor the
 * statement.
 */
export interface RemovalConfirmEmail {
  kind: "removal-confirm";
  to: string;
  url: string;
}

/**
 * The wait list's launch email, on the email-bulk queue only. `url` is the one-click
 * unsubscribe link holding the address's token (ARCHITECTURE, Wait list).
 */
export interface WaitlistLaunchEmail {
  kind: "waitlist-launch";
  to: string;
  url: string;
}

export type EmailMessage =
  | SignInEmail
  | WaitlistConfirmEmail
  | RemovalConfirmEmail
  | WaitlistLaunchEmail;

const SITE = "https://rarepair.fans";
const MAX_URL = 2048;

// Each kind links to one page on the site, and to nothing else: a sign-in link to GET
// /login/confirm (ARCHITECTURE, Auth and Hosts), a wait list link to GET /waitlist/confirm,
// a removal confirmation link to GET /remove/confirm.
const LINK_PATHS: Record<EmailMessage["kind"], string> = {
  "sign-in": "/login/confirm",
  "waitlist-confirm": "/waitlist/confirm",
  "removal-confirm": "/remove/confirm",
  "waitlist-launch": "/waitlist/unsubscribe",
};

/**
 * Whether the mailer sends to an address: a bare address only, with no display name and no
 * list and no control characters, at most 254 characters. apps/web accepts a wait list
 * address only if this would.
 */
export const isSendableAddress = (to: string) =>
  to.length <= 254 &&
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  /^[^\s@<>()",;:\\[\]\u0000-\u001f\u007f-\u009f]+@[^\s@<>()",;:\\[\]\u0000-\u001f\u007f-\u009f]+$/.test(
    to,
  );

// A wait list link carries its token and nothing else: base64url, as apps/web makes it.
const WAITLIST_QUERY = /^\?token=[A-Za-z0-9_-]+$/;

// Returns the message if its body keeps the contract, or null. A body that doesn't can never
// be sent, so retrying it would only keep an address in the queue longer.
export function parseMessage(body: unknown): EmailMessage | null {
  if (typeof body !== "object" || body === null) return null;
  // SAFETY: body is a non-null object, so reading named properties off it is safe; each value
  // is checked below.
  const { kind, to, url } = body as Record<string, unknown>;
  if (
    kind !== "sign-in" &&
    kind !== "waitlist-confirm" &&
    kind !== "removal-confirm" &&
    kind !== "waitlist-launch"
  ) {
    return null;
  }
  if (typeof to !== "string" || !isSendableAddress(to)) return null;
  if (typeof url !== "string" || url.length > MAX_URL) return null;
  // The kind's own page on the site, with no user info to disguise the host and no fragment.
  const link = URL.parse(url);
  if (link === null || link.origin !== SITE || link.pathname !== LINK_PATHS[kind]) return null;
  if (link.username !== "" || link.password !== "" || link.href.includes("#")) return null;
  // A wait list link without its token could act on nothing, and needs nothing more.
  if (kind !== "sign-in" && !WAITLIST_QUERY.test(link.search)) return null;
  // The parsed href, not the raw string: parsing drops line breaks that would add lines to the email.
  return { kind, to, url: link.href };
}
