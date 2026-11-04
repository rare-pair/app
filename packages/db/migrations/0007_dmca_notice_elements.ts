// The statutory elements of a DMCA notice (17 U.S.C. 512(c)(3)(A)) on `takedowns`,
// for the `/dmca` form. The element about the copyrighted work is `basis`, and the
// contact information is `requester`, so neither is added; the work and where the
// material is are named by `work_id`. A notice missing an element is still stored,
// so each new column has a default: text empty, a statement not made. `incomplete`
// is set by the writer when any element is missing, and the takedowns queue shows
// it. Notices already stored keep `incomplete` false: they were never checked.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "takedowns"
  add column "signature" text not null default '',
  add column "infringing_material" text not null default '',
  add column "good_faith" boolean not null default false,
  add column "accuracy_authority" boolean not null default false,
  add column "incomplete" boolean not null default false;
`;
