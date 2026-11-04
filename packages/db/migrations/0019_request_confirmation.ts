// A removal request or opt-out hides only after its contact address is confirmed by an emailed
// link (ARCHITECTURE, Author requests & takedowns), as the wait list's is. The token is kept
// only as a hash, so a link finds its request by that hash and a database read can't confirm
// anything. `confirm_sent_at` is when the one email was queued, for the 7 days a link lasts;
// `confirmed_at` is set once, with the hide, and the hash is cleared then, so a link works
// once. Requests made before this migration already hid at once, so they count as confirmed
// from the day they were made (a data update: nothing is dropped). No new status: an
// unconfirmed request is still `pending`, so the moderators' queue and reject are unchanged.
// Add-only: never edit this file once merged.
export default /* sql */ `
alter table "requests" add column "confirm_token_hash" text;
alter table "requests" add column "confirm_sent_at" timestamptz;
alter table "requests" add column "confirmed_at" timestamptz;

-- A confirmation link finds its request by the token's hash.
create unique index "requests_confirm_token_hash_key" on "requests" ("confirm_token_hash");

update "requests" set "confirmed_at" = "created_at";
`;
