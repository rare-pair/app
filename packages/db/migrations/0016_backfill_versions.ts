// A version can now be re-made from a stored original by the re-sanitize backfill (I7), not
// only made by an upload. `source` says which. A backfill version has no upload of its own
// (`upload_id` NULL, so the one-version-per-upload tie stays for uploads) and names in
// `source_upload_id` the upload whose original, `originals/<id>.epub`, it was re-made from, so
// the work page's download link and a later backfill still find the file. Every existing
// version came from an upload.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "work_versions" alter column "upload_id" drop not null;
alter table "work_versions" add column "source" text not null default 'upload';
alter table "work_versions" add column "source_upload_id" text references "uploads" ("id");
alter table "work_versions" add constraint "work_versions_source_check" check (
  ("source" = 'upload' and "upload_id" is not null and "source_upload_id" is null)
  or ("source" = 'backfill' and "upload_id" is null and "source_upload_id" is not null)
);
`;
