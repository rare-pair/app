// An account can be deleted on request (ARCHITECTURE, Deleting an account). Its uploads stay,
// with no user attached: `uploads.user_id` becomes nullable and is set null by the delete. The
// other columns that blocked the delete lose their foreign key and keep the id as it was, as
// `moderation_actions.moderator_id` did in 0014: a deleted reporter's report still counts toward
// an automatic hide, and who resolved a takedown or made a block stays on record. `session` and
// `account` already cascade. 0002 and 0004 created the constraints inline, so Postgres named them
// by default.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "uploads"
  alter column "user_id" drop not null,
  drop constraint "uploads_user_id_fkey",
  add constraint "uploads_user_id_fkey"
    foreign key ("user_id") references "user" ("id") on delete set null;

alter table "reports"
  drop constraint "reports_reporter_id_fkey";

alter table "takedowns"
  drop constraint "takedowns_resolved_by_fkey";

alter table "requester_blocks"
  drop constraint "requester_blocks_created_by_fkey";
`;
