// A new upload status, `work_removed` (U7): ingest refuses an upload of a work that is
// `removed` (by a moderator, or at its author's request) and no takedown or opt-out already
// decides. Its job ends the upload with this status, with no work set.
// Add-only: never edit this file once merged. The check is dropped and re-added with the
// old statuses kept, as 0002 says a new status must be.
export default /* sql */ `
alter table "uploads" drop constraint "uploads_status_check";
alter table "uploads" add constraint "uploads_status_check"
  check ("status" in (
    'pending', 'processing', 'live', 'held_for_review', 'duplicate',
    'not_epub', 'zip_bomb', 'too_large', 'not_ao3', 'opted_out', 'parse_failed',
    'over_quota', 'work_removed'
  ));
`;
