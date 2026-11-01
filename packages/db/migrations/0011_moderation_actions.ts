// The moderation action log (ARCHITECTURE, Data model): one row per action a
// moderator or an admin takes, written in the action's own transaction. Past
// actions have no actor to backfill, so it starts empty. `target_id` points at
// different tables by `target_kind`, so it has no foreign key. `action` and
// `target_kind` are free text, checked in TypeScript, so a new action needs no
// migration. `note` is short and never holds reader data or a requester's email.
// Add-only: never edit this file once merged.
export default /* sql */ `
create table "moderation_actions" (
  "id" text not null primary key default gen_random_uuid()::text,
  "moderator_id" text not null references "user" ("id"),
  "action" text not null,
  "target_kind" text not null,
  "target_id" text not null,
  "note" text,
  "created_at" timestamptz not null default current_timestamp,
  constraint "moderation_actions_note_not_blank" check ("note" ~ '[^[:space:]]'),
  constraint "moderation_actions_note_length" check (char_length("note") <= 200)
);

create index "moderation_actions_target_idx"
  on "moderation_actions" ("target_kind", "target_id", "created_at");
create index "moderation_actions_created_at_idx" on "moderation_actions" ("created_at");
create index "moderation_actions_moderator_id_idx" on "moderation_actions" ("moderator_id");
`;
