// The daily upload quota (U4). `user.upload_quota_used` counts the uploads confirmed on
// `upload_quota_day`, a UTC calendar day: when the stored day isn't today the count starts
// again from zero, so nothing has to reset it at midnight. NULL, for accounts that have
// never confirmed an upload, counts as no day. An upload that is confirmed over the
// quota gets the new status `over_quota` (its object is deleted).
// Add-only: never edit this file once merged. The check is dropped and re-added with the
// old statuses kept, as 0002 says a new status must be.
export default /* sql */ `
alter table "user" add column "upload_quota_day" date;

alter table "uploads" drop constraint "uploads_status_check";
alter table "uploads" add constraint "uploads_status_check"
  check ("status" in (
    'pending', 'processing', 'live', 'held_for_review', 'duplicate',
    'not_epub', 'zip_bomb', 'too_large', 'not_ao3', 'opted_out', 'parse_failed',
    'over_quota'
  ));
`;
