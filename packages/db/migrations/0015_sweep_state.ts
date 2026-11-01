// Where the periodic sweep (apps/sweep, O2) stopped: one row. A run sweeps a bounded number of
// `works/<ao3_work_id>/` folders, in R2's key order, and the next run lists after `after`.
// NULL starts from the first folder.
// Add-only: never edit this file once merged.
export default /* sql */ `
create table "sweep_state" (
  "id" integer not null primary key default 1 check ("id" = 1),
  "after" text,
  "updated_at" timestamptz not null default current_timestamp
);
insert into "sweep_state" ("id") values (1);
`;
