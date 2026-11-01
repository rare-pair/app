import type { ColumnType, Generated } from "kysely";

// Column names are the database's (snake_case, as in ARCHITECTURE's Data model).
// Better Auth reads and writes them through `authSchema`'s field mapping.

/** A timestamptz: read as a Date, written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** A timestamptz the database fills in when the insert leaves it out. */
type CreatedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UserTable {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  created_at: CreatedTimestamp;
  updated_at: CreatedTimestamp;
  // Our fields (ARCHITECTURE, Data model).
  role: string | null;
  upload_quota_used: Generated<number>;
  /** The UTC day `upload_quota_used` counts, as `YYYY-MM-DD`. NULL until the first confirmed upload. */
  upload_quota_day: ColumnType<string | null, string | null | undefined, string | null>;
  banned_at: Timestamp | null;
  /** NULL until a new account accepts the terms. */
  terms_accepted_at: Timestamp | null;
  /** A signed-in reader turned the warnings screen off. */
  warnings_off: Generated<boolean>;
}

export interface SessionTable {
  id: string;
  user_id: string;
  token: string;
  expires_at: Timestamp;
  ip_address: string | null;
  user_agent: string | null;
  created_at: CreatedTimestamp;
  updated_at: Timestamp;
}

export interface AccountTable {
  id: string;
  user_id: string;
  account_id: string;
  provider_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: Timestamp | null;
  refresh_token_expires_at: Timestamp | null;
  scope: string | null;
  /** Part of Better Auth's core schema. Never written: no passwords are stored. */
  password: string | null;
  created_at: CreatedTimestamp;
  updated_at: Timestamp;
}

/** Holds hashed magic-link tokens. */
export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: Timestamp;
  created_at: CreatedTimestamp;
  updated_at: CreatedTimestamp;
}

/** Better Auth's rate-limit counters, one row per limited key. */
export interface RateLimitTable {
  id: string;
  key: string;
  count: number;
  /** Milliseconds since the epoch. A bigint, so pg reads it as a string. */
  last_request: ColumnType<string, number | string, number | string>;
}

export type WorkStatus = "processing" | "live" | "hidden" | "removed";
export type HiddenCause = "removal_request" | "reports" | "moderator";
/** Every tag type, as the `tags.type` check allows. */
export const TAG_TYPES = [
  "fandom",
  "relationship",
  "character",
  "freeform",
  "warning",
  "category",
  "rating",
] as const;
export type TagType = (typeof TAG_TYPES)[number];
/** The pipeline's statuses, then the rejection codes (ARCHITECTURE, Ingestion pipeline). */
export type UploadStatus =
  | "pending"
  | "processing"
  | "live"
  | "held_for_review"
  | "duplicate"
  | "not_epub"
  | "zip_bomb"
  | "too_large"
  | "not_ao3"
  | "opted_out"
  | "parse_failed"
  | "over_quota"
  | "work_removed";

export interface WorkTable {
  id: Generated<string>;
  /** The URL key. */
  ao3_work_id: number;
  title: string;
  summary_html: string | null;
  rating: string | null;
  language: string | null;
  words: number | null;
  chapters_count: number;
  /** The planned total (AO3's y in x/y). NULL when unknown. */
  chapters_total: number | null;
  complete: boolean;
  /** AO3's dates for the work, not the row's. */
  published_at: Timestamp | null;
  updated_at: Timestamp | null;
  status: ColumnType<WorkStatus, WorkStatus | undefined, WorkStatus>;
  /** Set while, and only while, the work is hidden. */
  hidden_cause: HiddenCause | null;
  /** NULL only while the first version is being written. */
  current_version_id: string | null;
  /** Preface labels the parser doesn't understand yet. Write it with `JSON.stringify`. */
  raw_meta: ColumnType<Record<string, string>, string | undefined, string>;
  /** A tsvector over `search_text`. Filled by `refreshWorkSearch`, in SQL, never as a bound string. */
  search: string | null;
  /** The title, bylines, tags and summary text the trigram index reads. Filled by `refreshWorkSearch`. */
  search_text: string | null;
}

export interface WorkAuthorTable {
  work_id: string;
  pseud: string;
  /** NULL for an anonymous work, or a byline with no user link. */
  ao3_user: string | null;
  /** The author's place in the byline, from 0. Unique per work. */
  position: number;
}

export interface WorkVersionTable {
  id: Generated<string>;
  work_id: string;
  upload_id: string;
  chapter_count: number;
  /** The planned total as this version's preface gave it. NULL when unknown. */
  chapter_total: number | null;
  /** `works/<ao3_work_id>/<upload_id>/`, with the trailing slash. */
  r2_prefix: string;
  created_at: CreatedTimestamp;
  /** From the parser. Non-empty, with `checked_at` still NULL, shows the "may be imperfect" notice. */
  review_reasons: ColumnType<string[], string[] | undefined, string[]>;
  /** Set when a moderator approves the version. */
  checked_at: Timestamp | null;
  /** This version's tags in the file's order, as ingest read them. NULL before migration 0010. Write it with `JSON.stringify`. */
  tags: ColumnType<VersionTag[] | null, string | null | undefined, string | null>;
  /** This version's byline in the file's order. NULL before migration 0010. Write it with `JSON.stringify`. */
  authors: ColumnType<VersionAuthor[] | null, string | null | undefined, string | null>;
}

export interface VersionTag {
  type: TagType;
  name: string;
}

export interface VersionAuthor {
  pseud: string;
  user: string | null;
}

export interface ChapterTable {
  work_id: string;
  version_id: string;
  n: number;
  title: string;
  words: number;
  /** The fragment's whole R2 key. Readers use it as is. */
  r2_key: string;
}

export interface TagTable {
  id: Generated<string>;
  type: TagType;
  /** Exactly as written. */
  name: string;
  /** `normalizeTagName(type, name)`, used for matching. */
  name_norm: string;
}

export interface WorkTagTable {
  work_id: string;
  tag_id: string;
  /** The tag's place in the work's tags, in the author's order. */
  position: number;
}

export interface UploadTable {
  id: Generated<string>;
  user_id: string;
  r2_key: string;
  /** NULL until `/complete` hashes the file. */
  sha256: string | null;
  bytes: number;
  status: ColumnType<UploadStatus, UploadStatus | undefined, UploadStatus>;
  lease_until: Timestamp | null;
  /** When a confirm counted this upload against the daily quota; NULL until then. */
  quota_counted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  error_stage: string | null;
  error: string | null;
  work_id: string | null;
  created_at: CreatedTimestamp;
}

export type RequestKind = "remove_work" | "opt_out";

export interface ReportTable {
  id: Generated<string>;
  work_id: string;
  /** Reporting needs an account. */
  reporter_id: string;
  /** `wrong_version` ("This version is wrong") is the only value the docs name. */
  kind: string;
  /** The optional details. */
  body: string | null;
  /** `open` until a moderator acts. */
  status: Generated<string>;
  created_at: CreatedTimestamp;
}

/** A DMCA notice. */
export interface TakedownTable {
  id: Generated<string>;
  work_id: string;
  requester: string;
  basis: string;
  /** `pending` until a moderator acts. */
  status: Generated<string>;
  /** The moderator who acted. */
  resolved_by: string | null;
  created_at: CreatedTimestamp;
  // The notice's statutory elements (17 U.S.C. 512(c)(3)(A)). `basis` names the copyrighted
  // work and `requester` is the contact information. Empty or false when the notice left it out.
  /** The typed full name that signs the notice. */
  signature: Generated<string>;
  /** What the allegedly infringing material is, beyond the work named by `work_id`. */
  infringing_material: Generated<string>;
  /** The good-faith statement, made. */
  good_faith: Generated<boolean>;
  /** The accuracy and authority statement, under penalty of perjury, made. */
  accuracy_authority: Generated<boolean>;
  /** A statutory element is missing. Set by the writer. */
  incomplete: Generated<boolean>;
}

/** A remove-my-work or opt-out request from `/remove`. */
export interface RequestTable {
  id: Generated<string>;
  kind: RequestKind;
  /** Set for `remove_work`. */
  work_id: string | null;
  /** `normalizePseud(pseud)`, set for `opt_out`. */
  pseud_norm: string | null;
  /** As given. Match with `lower()` on both sides. */
  contact_email: string;
  statement: string;
  /** `pending` until a moderator acts. */
  status: Generated<string>;
  /** Never the raw IP. */
  ip_hash: string;
  created_at: CreatedTimestamp;
}

/** Checked at ingest: an active row rejects a byline whose `normalizePseud` matches. */
export interface OptoutTable {
  id: Generated<string>;
  pseud_norm: string;
  /** Set when the request names an AO3 user. */
  ao3_user: string | null;
  request_id: string;
  active: boolean;
  created_at: CreatedTimestamp;
}

/** Matches a later request by email or by IP hash, and a report by its account's email. */
export interface RequesterBlockTable {
  id: Generated<string>;
  /** As given. Match with `lower()` on both sides. */
  contact_email: string | null;
  ip_hash: string | null;
  /** The moderator who blocked. */
  created_by: string;
  created_at: CreatedTimestamp;
}

/** One row per moderation action (ARCHITECTURE, Data model). Ids only: no reader data. */
export interface ModerationActionTable {
  id: Generated<string>;
  /** The acting moderator or admin. */
  moderator_id: string;
  action: string;
  target_kind: string;
  /** The target row's own id. No foreign key: it points at different tables. */
  target_id: string;
  note: string | null;
  created_at: CreatedTimestamp;
}

/**
 * The launch wait list (ARCHITECTURE, Wait list): only what the launch email needs.
 * Tokens are stored as SHA-256 hex hashes, never as themselves.
 */
export interface WaitlistTable {
  /** Trimmed and lowercased. */
  email: string;
  /** Cleared once confirmed. */
  confirm_token_hash: string | null;
  /** The latest confirmation email's time: its link lasts 7 days from it. */
  confirm_sent_at: CreatedTimestamp;
  /** Confirmation emails sent, 3 at most. */
  confirm_count: Generated<number>;
  confirmed_at: Timestamp | null;
  notified_at: Timestamp | null;
  unsubscribe_token_hash: string | null;
  created_at: CreatedTimestamp;
}

/** Where the periodic sweep (apps/sweep) stopped: one row, `id` 1. */
export interface SweepStateTable {
  id: ColumnType<number, never, never>;
  /** The R2 key the next run lists after, past the last folder swept. NULL for the first folder. */
  after: string | null;
  updated_at: CreatedTimestamp;
}

export interface Database {
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  works: WorkTable;
  work_authors: WorkAuthorTable;
  work_versions: WorkVersionTable;
  chapters: ChapterTable;
  tags: TagTable;
  work_tags: WorkTagTable;
  uploads: UploadTable;
  rateLimit: RateLimitTable;
  reports: ReportTable;
  takedowns: TakedownTable;
  requests: RequestTable;
  optouts: OptoutTable;
  requester_blocks: RequesterBlockTable;
  moderation_actions: ModerationActionTable;
  waitlist: WaitlistTable;
  sweep_state: SweepStateTable;
}
