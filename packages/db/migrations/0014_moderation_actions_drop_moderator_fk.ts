// The moderation action log keeps its rows when an account is deleted, so
// `moderator_id` no longer references "user" (ARCHITECTURE, Moderation). The log
// is an audit trail: a moderator who leaves, or whose account is removed, must
// not erase what they did, and must not be undeletable because they acted. The
// column stays NOT NULL and keeps its index; it now holds the id as it was.
// 0011 created the constraint inline, so Postgres named it by default.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "moderation_actions"
  drop constraint "moderation_actions_moderator_id_fkey";
`;
