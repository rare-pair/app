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
  /** Neon Postgres. */
  HYPERDRIVE: Hyperdrive;
  /** Chapter fragments, under works/ (ARCHITECTURE, Reading). */
  BUCKET: R2Bucket;
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
  /** The least milliseconds `POST /waitlist` takes to answer (src/floor.ts), as a number. */
  WAITLIST_FLOOR_MS: string;
  TURNSTILE_SECRET_KEY: string;
  /** Keys the HMAC of a requester's network address (src/ip-hash.ts). */
  IP_HASH_KEY: string;
  /** The moderators' contact address, shown to a visitor without JavaScript (wrangler.jsonc). */
  MODERATORS_EMAIL: string;
  /** Signs Better Auth's session cookies. */
  BETTER_AUTH_SECRET: string;
  /** The bucket presigned upload URLs PUT into (src/presign.ts). */
  R2_BUCKET: string;
  /** The Cloudflare account whose R2 S3 endpoint presigned URLs name. */
  R2_ACCOUNT_ID: string;
  /** The R2 API token presigned URLs are signed with: Object Read and Write on R2_BUCKET only. */
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};
