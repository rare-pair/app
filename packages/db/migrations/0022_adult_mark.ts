// A moderator's mark that a work is adult (ARCHITECTURE, Reading, Warnings screen): a work
// with the mark gets the warnings screen whatever its rating says. It sits on `works`, not on
// a version, so a new version or a rollback keeps it. Add-only: never edit this file once merged.
export default /* sql */ `
alter table "works" add column "adult_marked" boolean not null default false;
`;
