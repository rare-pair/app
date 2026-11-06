// Every migration, in the order it applies. Append new ones; never edit or
// reorder an entry once merged. The name is what `schema_migrations` records.
import m0001 from "./0001_better_auth";
import m0002 from "./0002_catalogue_and_uploads";
import m0003 from "./0003_better_auth_rate_limit";
import m0004 from "./0004_requests_reports_moderation";
import m0005 from "./0005_chapter_total_and_author_order";
import m0006 from "./0006_waitlist";
import m0007 from "./0007_dmca_notice_elements";
import m0008 from "./0008_search";
import m0009 from "./0009_upload_quota_day";
import m0010 from "./0010_version_tags_and_authors";
import m0011 from "./0011_moderation_actions";
import m0012 from "./0012_version_work_columns";
import m0013 from "./0013_upload_work_removed";
import m0014 from "./0014_moderation_actions_drop_moderator_fk";
import m0015 from "./0015_sweep_state";
import m0017 from "./0017_upload_account_banned";
import m0016 from "./0016_backfill_versions";
import m0018 from "./0018_request_works";
import m0019 from "./0019_request_confirmation";
import m0020 from "./0020_account_delete";

export const migrations: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "0001_better_auth", sql: m0001 },
  { name: "0002_catalogue_and_uploads", sql: m0002 },
  { name: "0003_better_auth_rate_limit", sql: m0003 },
  { name: "0004_requests_reports_moderation", sql: m0004 },
  { name: "0005_chapter_total_and_author_order", sql: m0005 },
  { name: "0006_waitlist", sql: m0006 },
  { name: "0007_dmca_notice_elements", sql: m0007 },
  { name: "0008_search", sql: m0008 },
  { name: "0009_upload_quota_day", sql: m0009 },
  { name: "0010_version_tags_and_authors", sql: m0010 },
  { name: "0011_moderation_actions", sql: m0011 },
  { name: "0012_version_work_columns", sql: m0012 },
  { name: "0013_upload_work_removed", sql: m0013 },
  { name: "0014_moderation_actions_drop_moderator_fk", sql: m0014 },
  { name: "0015_sweep_state", sql: m0015 },
  { name: "0017_upload_account_banned", sql: m0017 },
  { name: "0016_backfill_versions", sql: m0016 },
  { name: "0018_request_works", sql: m0018 },
  { name: "0019_request_confirmation", sql: m0019 },
  { name: "0020_account_delete", sql: m0020 },
];
