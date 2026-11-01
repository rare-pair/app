// The sign-in limits as wrangler.jsonc sets them: requests per IP and per email address in a
// window. Shared by the workerd tests and the Node test that checks them against the config.

export const LOGIN_IP_LIMIT = 10;
export const LOGIN_EMAIL_LIMIT = 3;

// The wait list's: the same two kinds of limit, over the same window.
export const WAITLIST_IP_LIMIT = 10;
export const WAITLIST_EMAIL_LIMIT = 3;

/** The least `WAITLIST_FLOOR_MS` may be set to in wrangler.jsonc, so a refactor can't zero it. */
export const WAITLIST_FLOOR_MIN_MS = 2000;

// POST /dmca, per client IP over the same window.
export const DMCA_IP_LIMIT = 5;
