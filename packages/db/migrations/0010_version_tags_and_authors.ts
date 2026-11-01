// A version's own tags and authors. `work_tags` and `work_authors` hold only the current
// version's, so a version held for review keeps its own here, for a moderator's approval to
// apply. Ingest writes both on every version it saves, as JSON arrays: tags as
// `{ type, name }` and authors as `{ pseud, user }`, in the file's order. NULL on a version
// written before this migration.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "work_versions" add column "tags" jsonb;
alter table "work_versions" add column "authors" jsonb;
`;
