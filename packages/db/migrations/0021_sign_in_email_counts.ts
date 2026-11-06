// The daily cap on sign-in emails (ARCHITECTURE, Surge controls): how many were asked for per
// address on a UTC calendar day. `address_hash` is a keyed hash, never the address. The day is
// in the key, so a new day starts from nothing; a counting request deletes earlier days' rows.
// Add-only: never edit this file once merged.
export default /* sql */ `
create table "sign_in_email_counts" (
  "address_hash" text not null,
  "day" date not null,
  "count" integer not null,
  primary key ("address_hash", "day")
);
`;
