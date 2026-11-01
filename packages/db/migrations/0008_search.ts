// Metadata search: trigram matching for typos, a text column for it to read,
// GIN indexes on that column and on the existing `works.search` tsvector, and a
// backfill of the works already here. `refreshWorkSearch` (src/search.ts) keeps
// both columns current from the same text: title, bylines, every tag and the
// summary with its markup removed. Chapter text is never indexed.
// `create extension` needs a role allowed to run it (pg_trgm is a trusted
// extension, so the database owner is).
// Add-only: never edit this file once merged. A change to what is indexed is a
// new migration that backfills again.
export default /* sql */ `
create extension if not exists pg_trgm;

alter table "works" add column "search_text" text;

create index "works_search_idx" on "works" using gin ("search");
create index "works_search_text_trgm_idx" on "works" using gin ("search_text" gin_trgm_ops);

-- Title weighs most (A), then byline and tags (B), then the summary (C).
update "works" set
  "search_text" = concat_ws(' ', indexed."title", indexed."byline", indexed."tags", indexed."summary"),
  "search" = setweight(to_tsvector('simple', indexed."title"), 'A')
    || setweight(to_tsvector('simple', indexed."byline"), 'B')
    || setweight(to_tsvector('simple', indexed."tags"), 'B')
    || setweight(to_tsvector('simple', indexed."summary"), 'C')
from (
  select w."id",
    w."title",
    coalesce((select string_agg(a."pseud", ' ' order by a."position")
       from "work_authors" a where a."work_id" = w."id"), '') as "byline",
    coalesce((select string_agg(t."name", ' ' order by wt."position")
       from "work_tags" wt join "tags" t on t."id" = wt."tag_id"
      where wt."work_id" = w."id"), '') as "tags",
    regexp_replace(coalesce(w."summary_html", ''), '<[^>]*>|&[#a-zA-Z0-9]+;', ' ', 'g') as "summary"
  from "works" w
) indexed
where "works"."id" = indexed."id";
`;
