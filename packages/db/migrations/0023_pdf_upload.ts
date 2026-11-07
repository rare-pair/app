// PDF upload (spec 12): what an upload was made from, its own refusal status, and the reason a
// PDF with more chapters than the current epub is held. An upload's `format` is set when it is
// ingested; every upload before this one was an epub. Add-only: never edit this file once merged.
// Each check is dropped and re-added with the old values kept, as 0002 says a new status must be.
export default /* sql */ `
alter table "uploads" add column "format" text not null default 'epub';
alter table "uploads" add constraint "uploads_format_check" check ("format" in ('epub', 'pdf'));
alter table "uploads" drop constraint "uploads_status_check";
alter table "uploads" add constraint "uploads_status_check"
  check ("status" in (
    'pending', 'processing', 'live', 'held_for_review', 'duplicate',
    'not_epub', 'zip_bomb', 'too_large', 'not_ao3', 'opted_out', 'parse_failed',
    'over_quota', 'work_removed', 'account_banned', 'pdf_unreadable'
  ));
alter table "work_versions" drop constraint "work_versions_hold_reason_check";
alter table "work_versions" add constraint "work_versions_hold_reason_check"
  check ("hold_reason" in (
    'chapters_changed', 'tags_changed', 'authors_changed', 'pdf_more_chapters'
  ));
`;
