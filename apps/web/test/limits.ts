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

// POST /uploads: per signed-in user and per client IP, over the same window. First values.
export const UPLOAD_USER_LIMIT = 20;
export const UPLOAD_IP_LIMIT = 40;

// GET /search: per signed-in user and per client IP, over the same window. First values,
// kept by the operator for launch.
export const SEARCH_IP_LIMIT = 30;
export const SEARCH_USER_LIMIT = 60;

// POST /remove: per client IP, and per contact email once Turnstile is solved. First values,
// to be revisited before launch.
export const REMOVE_IP_LIMIT = 5;
export const REMOVE_EMAIL_LIMIT = 3;

// Reads per client over the same window: chapter pages and whole works. First values, to be
// revisited in load testing (spec 24).
export const READ_CHAPTER_LIMIT = 120;
export const READ_FULL_LIMIT = 10;
