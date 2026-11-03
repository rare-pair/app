// The works a removal request hid, so reversing the request restores exactly those and no
// work it didn't hide (ARCHITECTURE, Data model). A row is written only when the request's
// own hide changed the work: a work already hidden by reports, a moderator or another request
// gets none. `work_id` has its own index because a work's requests are looked up by work as
// well as by request. Nothing cascades: works are removed by status, never deleted.
// Add-only: never edit this file once merged. A new check is a new migration.
export default /* sql */ `
create table "request_works" (
  "request_id" text not null references "requests" ("id"),
  "work_id" text not null references "works" ("id"),
  primary key ("request_id", "work_id")
);

create index "request_works_work_id_idx" on "request_works" ("work_id");
`;
