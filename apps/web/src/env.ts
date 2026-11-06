// The `email` queue's contract lives with its consumer. A type-only import: of
// apps/mailer, the Worker bundles only the address rule waitlist.ts imports.
import type { EmailMessage } from "../../mailer/src/message";
// The same for the `ingest` queue: its contract lives with apps/ingest.
import type { IngestMessage } from "../../ingest/src/message";

/** The web Worker's bindings, vars and secrets (wrangler.jsonc). */
export type Bindings = {
  PRELAUNCH?: string;
  TURNSTILE_SITE_KEY: string;
  ASSETS: Fetcher;
  /**
   * Neon Postgres through the Hyperdrive config with caching off. The default for every read:
   * sessions, roles, moderation, uploads, and anything a public page doesn't read.
   */
  HYPERDRIVE: Hyperdrive;
  /**
   * The same database through a config with caching on, for public pages only (home, listings,
   * search, work page, reader, full, warnings). A read here can be up to about 75 s old
   * (ARCHITECTURE, Connections), so nothing that decides a write goes through it.
   */
  HYPERDRIVE_CACHED: Hyperdrive;
  /** Chapter fragments, under works/ (ARCHITECTURE, Reading). */
  BUCKET: R2Bucket;
  /** Signed-in readers' saved reading positions, one key each (src/position.ts). */
  POSITIONS: KVNamespace;
  /** The queue apps/mailer sends from. */
  EMAIL: Queue<EmailMessage>;
  /** The queue apps/ingest consumes: one `{ upload_id }` per confirmed upload. */
  INGEST: Queue<IngestMessage>;
  /** `POST /login` requests per client IP (src/rate-limit.ts). */
  LOGIN_IP_LIMIT: RateLimit;
  /** `POST /login` requests per email address (src/rate-limit.ts). */
  LOGIN_EMAIL_LIMIT: RateLimit;
  /** `POST /waitlist` requests per client IP (src/rate-limit.ts). */
  WAITLIST_IP_LIMIT: RateLimit;
  /** `POST /waitlist` requests per email address (src/rate-limit.ts). */
  WAITLIST_EMAIL_LIMIT: RateLimit;
  /** `POST /dmca` requests per client IP (src/rate-limit.ts). */
  DMCA_IP_LIMIT: RateLimit;
  /** `POST /uploads` requests per signed-in user (src/rate-limit.ts). */
  UPLOAD_USER_LIMIT: RateLimit;
  /** `POST /uploads` requests per client IP (src/rate-limit.ts). */
  UPLOAD_IP_LIMIT: RateLimit;
  /** `GET /search` requests per signed-in user (src/rate-limit.ts). */
  SEARCH_USER_LIMIT: RateLimit;
  /** `GET /search` requests per client IP (src/rate-limit.ts). */
  SEARCH_IP_LIMIT: RateLimit;
  /** `POST /remove` requests per client IP (src/rate-limit.ts). */
  REMOVE_IP_LIMIT: RateLimit;
  /** `POST /remove` requests per contact email address (src/rate-limit.ts). */
  REMOVE_EMAIL_LIMIT: RateLimit;
  /** The least milliseconds `POST /waitlist` takes to answer (src/floor.ts), as a number. */
  WAITLIST_FLOOR_MS: string;
  /** Uploads a new account (and any non-moderator) may confirm per UTC day (src/quota.ts). */
  UPLOAD_QUOTA_NEW: string;
  /** Uploads a moderator or admin may confirm per UTC day (src/quota.ts). */
  UPLOAD_QUOTA_TRUSTED: string;
  /** Sign-in emails one address may be sent per UTC day (src/quota.ts). */
  LOGIN_EMAIL_QUOTA: string;
  TURNSTILE_SECRET_KEY: string;
  /** Keys the HMAC of a requester's network address, and of the daily sign-in count's address (src/ip-hash.ts). */
  IP_HASH_KEY: string;
  /** The moderators' contact address, shown to a visitor without JavaScript (wrangler.jsonc). */
  MODERATORS_EMAIL: string;
  /** Where the copyright notice page's <noscript> message sends a visitor without JavaScript (wrangler.jsonc). */
  NOTICES_EMAIL: string;
  /** Signs Better Auth's session cookies. */
  BETTER_AUTH_SECRET: string;
  /** The Cloudflare API token removal purges the cache with: Cache Purge on the zone only (src/purge.ts). */
  CLOUDFLARE_PURGE_TOKEN: string;
  /** The rarepair.fans zone, whose cache removal purges (wrangler.jsonc). */
  CLOUDFLARE_ZONE_ID: string;
};
