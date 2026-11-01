// Each version's own copy of the `works` columns that describe it, as its file gave them
// (NULL for a field the file lacked), and the reason a held version was held. `works` keeps
// the current version's values: a replace, a make-current and an approval copy the version's
// non-NULL fields onto it. The counts were already per version (`chapter_count`,
// `chapter_total`). The current version of each work is backfilled from the work, and its tags
// and byline from `work_tags` and `work_authors` where migration 0010 left them NULL; every
// other version written before this stays NULL, as nothing records what its file had.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "work_versions" add column "title" text;
alter table "work_versions" add column "summary_html" text;
alter table "work_versions" add column "rating" text;
alter table "work_versions" add column "language" text;
alter table "work_versions" add column "words" integer;
alter table "work_versions" add column "complete" boolean;
alter table "work_versions" add column "published_at" timestamptz;
alter table "work_versions" add column "updated_at" timestamptz;
alter table "work_versions" add column "raw_meta" jsonb;
alter table "work_versions" add column "hold_reason" text;
alter table "work_versions" add constraint "work_versions_hold_reason_check"
  check ("hold_reason" in ('chapters_changed', 'tags_changed', 'authors_changed'));

update "work_versions" v set
  "title" = w."title",
  "summary_html" = w."summary_html",
  "rating" = w."rating",
  "language" = w."language",
  "words" = w."words",
  "complete" = w."complete",
  "published_at" = w."published_at",
  "updated_at" = w."updated_at",
  "raw_meta" = w."raw_meta",
  "tags" = coalesce(v."tags", (
    select coalesce(jsonb_agg(jsonb_build_object('type', t."type", 'name', t."name")
      order by wt."position"), '[]')
    from "work_tags" wt join "tags" t on t."id" = wt."tag_id"
    where wt."work_id" = w."id"
  )),
  "authors" = coalesce(v."authors", (
    select coalesce(jsonb_agg(jsonb_build_object('pseud', a."pseud", 'user', a."ao3_user")
      order by a."position"), '[]')
    from "work_authors" a
    where a."work_id" = w."id"
  ))
from "works" w
where w."current_version_id" = v."id";
`;
