// A new upload status, `account_banned` (MOD6): a moderator banned the uploader's account. The
// ban ends the account's `pending` uploads with it, and ingest ends a job of a banned account's
// upload with it, at job start or in the save's transaction.
// Add-only: never edit this file once merged. The check is dropped and re-added with the
// old statuses kept, as 0002 says a new status must be.
export default /* sql */ `
alter table "uploads" drop constraint "uploads_status_check";
alter table "uploads" add constraint "uploads_status_check"
  check ("status" in (
    'pending', 'processing', 'live', 'held_for_review', 'duplicate',
    'not_epub', 'zip_bomb', 'too_large', 'not_ao3', 'opted_out', 'parse_failed',
    'over_quota', 'work_removed', 'account_banned'
  ));
`;
