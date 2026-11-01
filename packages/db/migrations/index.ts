// Every migration, in the order it applies. Append new ones; never edit or
// reorder an entry once merged. The name is what `schema_migrations` records.
import m0001 from "./0001_better_auth";
import m0002 from "./0002_catalogue_and_uploads";
import m0003 from "./0003_better_auth_rate_limit";
import m0004 from "./0004_requests_reports_moderation";
import m0005 from "./0005_chapter_total_and_author_order";
import m0006 from "./0006_waitlist";
import m0007 from "./0007_dmca_notice_elements";

export const migrations: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "0001_better_auth", sql: m0001 },
  { name: "0002_catalogue_and_uploads", sql: m0002 },
  { name: "0003_better_auth_rate_limit", sql: m0003 },
  { name: "0004_requests_reports_moderation", sql: m0004 },
  { name: "0005_chapter_total_and_author_order", sql: m0005 },
  { name: "0006_waitlist", sql: m0006 },
  { name: "0007_dmca_notice_elements", sql: m0007 },
];
