# Architecture & MVP scope

A temporary, community-run reading archive for fanworks while AO3 is offline.
People upload the `.epub` files they downloaded from AO3, and anyone can browse,
search and read them in the browser.

**Name:** rarepair (lowercase, one word), at `rarepair.fans`. We must not use
the AO3 or OTW names, logos or site styling, and must not imply any affiliation.
Every work page links back to its original AO3 URL and says plainly that this is
an unofficial stopgap.

## Decisions so far

| Question | Decision |
| --- | --- |
| Name and domain | rarepair, always written lowercase as one word. The site is served at `rarepair.fans`, and `www.rarepair.fans` redirects there. Epub images and original downloads are served from `content.rarepair.fans` |
| Who can read uploads | Shared public archive. Every upload is readable by everyone, with takedowns and author removal requests from day one. The one exception is below, in Crawlers and agents |
| Crawlers and agents | Clients that declare themselves automated are refused fic text: chapters, `/full`, images and originals. Work pages, tag listings and search are not refused. Reading stays public, with no challenge and no sign-in, so anything posing as a browser is only throttled (operator ruling, 2026-11-04) |
| Hosting | Cloudflare on the Workers Paid plan: Workers, R2 (one bucket for every prefix), Queues, KV, plus Neon Postgres through Hyperdrive: a config with caching off for every read that decides something, and one with caching on for public pages only (see Connections). Workers Paid is an operator ruling, 2026-11-05 |
| Load target | Surge-ready: assume tens of thousands of signups in the first days |
| Sign-in | Email magic link with no passwords stored, through Better Auth (self-hosted in the Worker, data in Neon) and Resend alone. There is no failover provider at launch, and while Resend is down sign-in stops until it returns (operator ruling, 2026-11-05) |
| Accepted files | AO3-native epub exports only. FanFicFare support comes later |
| New versions | Replace the current version automatically only if newer and consistent with it. Otherwise hold for review. A consistent edit goes live with no hold: readers' reports and rollback are the check (operator ruling, 2026-11-05). The re-sanitize backfill re-makes the current version from its own original, as a new version (operator ruling, 2026-11-01) |
| A file swapped after confirm | Ingest handles the file it read and records that file's hash. A mismatch with confirm's hash isn't refused, and no locked copy is made (operator ruling, 2026-11-05) |
| Author identity | No work claims and no author verification while AO3 is down. Removal and opt-out are requests anyone can make, without proving who they are, and they take effect once the requester confirms control of the contact email |
| Removal list | Removed works (title, byline, a link to the original with its ID, date, reason) are public at `/removed`, and pseuds with an approved opt-out at `/removed/pseuds`. Reasons come from a fixed list, never free text. Open requests and hidden works are never listed, and a moderator can withhold an entry |
| Search scope | Metadata only: title, author, tags, summary |
| Chapter rendering | Inline in app pages behind a strict CSP, with no iframe |
| Wait list | Before launch, `/` is a coming-soon page with a double opt-in wait list. Each confirmed address is sent one launch email, from the same mail subdomain as sign-in, spread over hours on its own queue. The list is deleted after the launch send |
| Sign-in emails per day | One address gets at most 5 sign-in emails a UTC day, counted in Postgres under a keyed hash, with no merging of `+tag` or dot spellings. The count fails open, and a failed send isn't given back. See Surge controls (operator ruling, 2026-11-05) |
| Requester data | What a requester sends with a removal or opt-out request (email address, hashed network address, statement), and a requester block's email and hash, is kept until the site closes, then deleted by hand. It is not erased on request. There is no retention sweep job and no migration for it. The only delete of a request's row is the rollback when its confirmation email cannot be queued. A copyright notice, with its sender's contact details and signature, follows the same rule (operator ruling, 2026-11-05). Account data is not covered: see Account deletion. |
| Account deletion | Someone asks at admin@rarepair.fans and the operator runs a script: no self-service button and no form (operator ruling, 2026-11-05). It removes the account, its sessions and its saved reading positions, bar one saved in the last moments, which expires within a year. Upload rows stay with no user attached, and works and versions stay public. The script refuses a banned account, because the ban would go with the row (pending the operator's ruling, wave 11). See Auth, Deleting an account |

## System overview

```
                 ┌──────────────────────── rarepair.fans ─────────────────────────┐
 Browser ──────▶ │  web Worker (Hono, server-rendered HTML)                       │
   │             │   • browse / search / work + chapter reader / auth / uploads   │
   │             │   • Turnstile + rate limits on signup, login, upload           │
   │             └──────┬──────────────┬──────────────────┬───────────────────────┘
   │                    │ Hyperdrive   │ KV               │ Queue: ingest
   │                    ▼              ▼                  ▼
   │              Neon Postgres    caches,           ingest Worker (consumer)
   │              (metadata, FTS,  reading pos.,      • unzip, parse OPF + AO3 preface
   │               users, auth)    rate counters      • sanitize chapter XHTML
   │                    ▲                             • write chapters to R2, rows to PG
   │                    └─────────────────────────────┘
   │  web Worker ── Queues: email, email-bulk ──▶ mailer Worker ──▶ Resend
   │  upload: presigned PUT from the browser (needs JS, like every Turnstile form)
   ├────────────────────────────────────────────────▶ R2: uploads/  (raw epubs)
   │
   │             ┌───────────────────── content.rarepair.fans ──────────────────────┐
   └──────────▶  │  content Worker: epub images + original-file downloads from R2   │
                 │  separate origin, no cookies, nosniff, edge 12 h, browser 1 h    │
                 │  reads work status from Postgres (Hyperdrive, uncached) on a miss│
                 └──────────────────────────────────────────────────────────────────┘
```

### Why these pieces

- **R2 for all bytes.** It has no egress fees, which matters most when the
  workload is mostly serving books. All prefixes live in one bucket, and the
  token the web Worker uses to presign uploads can read and write the whole
  bucket, not just `uploads/`. We accept the risk that a leak of that token
  exposes every object. Fresh uploads land in `uploads/`, which
  expires on its own. Original files we keep go in `originals/`, and processed
  chapters go under `works/<ao3_work_id>/<upload_id>/`: one prefix per version,
  keyed by the upload that produced it, so a retried job overwrites only its own
  files. A version the re-sanitize backfill re-makes has no upload of its own
  and goes under `works/<ao3_work_id>/<version id>/` (EPUB processor, step 8).
  `work_versions.r2_prefix` records it; version numbers live only in
  Postgres. The AO3 work ID is known once the preface is parsed, before anything
  is written.
- **Neon Postgres over D1.** D1 is capped at 10 GB per database, the cap can't
  be raised, and each database runs one query at a time. AO3 has more than 15M
  works. Even metadata-only rows (title, summary, tags) for a large share of
  them would pass 10 GB, and sharding search across D1 databases is work we
  don't need. Postgres also gives us `tsvector` full-text search and `pg_trgm`
  fuzzy matching. Chapter text lives in R2, not in the database.
- **Queues for ingestion.** Parsing happens off the request path, so a flood of
  uploads becomes a backlog, not an outage. Production runs on the Workers Paid plan (operator ruling,
  2026-11-05). Queue consumers get 128 MB of memory, which is plenty for an epub
  capped at 25 MB. Their CPU time per invocation is not measured: an earlier
  claim of 15 minutes was never checked. The paid plan's subrequest limit is
  about 10,000 calls, so `/full` over 49 chapters no longer breaks, and there is
  no chapter cap unless measurements show a run reaching the limit.
- **Two layers of XSS defense, with no iframe.** Epubs are zip files of arbitrary
  HTML. The sanitized chapter HTML is rendered straight into app pages. The
  second layer is a strict, nonce-based CSP on every app page, so a script that
  gets past the sanitizer still can't run (see Reading). The separate
  `content.rarepair.fans` origin, which sets no cookies, is kept only for the bytes
  we serve as they are: images from inside epubs and original-file downloads.
- **Hosts.** The web Worker answers only on `rarepair.fans` and the content
  Worker only on `content.rarepair.fans`. Every Worker sets `workers_dev = false`
  and `preview_urls = false`, so no second copy of the app is reachable on a
  `workers.dev` or preview URL.
  - `www.rarepair.fans` is routed to the web Worker. It answers every request
    there, whatever the method, with a **308** to the same path and query on
    `rarepair.fans`. A 308, unlike a 301, keeps a POST a POST.
  - Better Auth's `baseURL` is `https://rarepair.fans` and its `trustedOrigins`
    holds only that origin, so a magic link always points at the bare domain,
    whatever host the request came in on.
  - Every web Worker response sends
    `Strict-Transport-Security: max-age=31536000; includeSubDomains`, which also
    covers `content.rarepair.fans`, and the zone has Always Use HTTPS on. The
    domain isn't submitted to the HSTS preload list: the archive is temporary,
    and leaving the list takes months.
  - Zone-level Cloudflare features that set cookies, such as Bot Fight Mode and
    challenge pages, must not apply to `content.rarepair.fans`. Bot Fight Mode
    can't be skipped by a rule, so it is off for the whole zone, and so are Super
    Bot Fight Mode, on a plan that has it, and Browser Integrity Check, which is on
    by default. Turnstile and the Workers' rate limits do that job instead
    (Crawlers and agents).
  - The content Worker keeps no per-request log (invocation logs are off), so its
    logs hold no reader address next to a work id. Errors and metrics are kept;
    traces are off too, so no reading data reaches them (the URL carries the work
    id). An operator may turn them on to chase a live fault, which records request
    URLs until they are turned off again, so only for as long as the fault needs.
    `apps/content/test/wrangler.test.ts` holds traces off, so that change edits it too.
  - The content Worker sits in front of the CDN cache, so it keeps its own: a plain
    `GET` for an image or an original is answered from the data centre's cache
    (`caches.default`, keyed by the bare URL) without an R2 read once the first
    response is stored, and a miss reads R2 and stores the 200 (a failed cache read
    counts as a miss, and requests that arrive before the store completes also miss). `HEAD`, errors (404, 405, 451, 503), `Range` and conditional
    requests never read or fill it. See *Surge controls*, Edge cache.
  - The content Worker reads Postgres, on the uncached Hyperdrive config (see
    *Connections*), for every request that does not hit its cache: a miss, `HEAD`,
    `Range` and conditional requests. It reads the work's status (an image by its AO3
    work id, an original through its upload) before any byte goes out, and serves
    only a `live` work's files: a hidden work's get 451, and a removed or unknown
    work's, an upload with no work (a refused file) and a held version's get 404, all
    with no body and `Cache-Control: no-store`. A duplicate upload follows its
    work. A cache hit needs no read. If the database can't be connected to, or can't answer,
    within 2 s each (two client-side timeouts, one on the connection and one on the query, each shown by its own test: one against a server that never answers (the connection timeout) and one against a server that accepts the connection and stalls the query (the query timeout); there is no server-side `statement_timeout`, which pg sends as a startup parameter that Hyperdrive may not pass on; the cost is that Postgres keeps running a query the client gave up on until it finishes, and with a database that has stopped answering, those queries pile up with the request rate, each holding a pooled Hyperdrive connection), the request fails closed (a request can hold its connection for up to about 4 s before it does): 503, empty, `no-store`, nothing stored and no bytes sent.
    An image is judged by its work alone: images are shared by every version of a work and keyed by their content hash, so a held version's image is served once the work is live, as an unguessable URL (only its original is refused). A refusal never names the hide cause. The connection is per request and the
    logs hold an error's class name only.

## Data model (first cut)

```sql
user         (id, email, name, email_verified, image, created_at, updated_at,  -- Better Auth's table
              role, upload_quota_used, upload_quota_day NULL, banned_at,      -- plus our fields
              -- upload_quota_used counts the uploads confirmed on upload_quota_day (a UTC day);
              -- a count dated any other day is zero. Trusted tier: role moderator or admin.
              terms_accepted_at NULL,  -- NULL until a new account accepts the terms
              warnings_off)            -- signed-in reader turned the warnings screen off
session, account, verification  -- Better Auth's tables; verification holds hashed magic-link tokens
works        (id, ao3_work_id UNIQUE NOT NULL, title, summary_html, rating, language,  -- ao3_work_id is the URL key
              words, chapters_count,
              chapters_total NULL,  -- the planned total (AO3's y in x/y); NULL when unknown
              complete, published_at, updated_at,
              status,            -- processing | live | hidden | removed
              hidden_cause NULL, -- removal_request | reports | moderator, while hidden
              removed_reason NULL, -- dmca | removal_request | wrong_file | site_safety; the schema's check, like hidden_cause's, allows it only while removed and requires it then
              removed_at NULL,   -- set with removed_reason, under the same check; a partial index on it, where status is removed, serves the removal list
              list_withheld,     -- the removal list shows no title, byline or AO3 ID
              current_version_id, raw_meta jsonb,
              search tsvector,   -- title A, byline and tags B, summary C; text search config `simple`
              search_text)       -- the same text, for pg_trgm fuzzy matching
work_authors (work_id, pseud, ao3_user NULL,
              position)  -- the author's place in the byline, from 0; unique per work
work_versions(id, work_id,
              upload_id NULL,         -- the upload that made it; NULL for a backfill version, which has none
              source,                 -- upload | backfill (step 8, The re-sanitize backfill)
              source_upload_id NULL,  -- a backfill version's original: the upload it was re-made from
              chapter_count,
              chapter_total NULL,  -- the planned total as this version's preface gave it
              r2_prefix, created_at,
              review_reasons text[],  -- from the parser; non-empty shows the notice
              checked_at NULL,        -- set when a moderator approves the version
              tags jsonb, authors jsonb,  -- this version's own tags and byline, in the file's order; work_tags and work_authors hold only the current version's
              title, summary_html, rating, language, words, complete,  -- this version's own copy of the works
              published_at, updated_at, raw_meta jsonb,                -- columns, as ingest read them from its file
                                      -- (NULL for a field it lacked); all NULL on a version saved
                                      -- before migration 0012 that wasn't current then
              hold_reason NULL)       -- chapters_changed | tags_changed | authors_changed, on a version held since 0012
chapters     (work_id, version_id, n, title, words, r2_key)
tags         (id, type, name, name_norm) -- type: fandom|relationship|character|freeform|warning|category|rating
work_tags    (work_id, tag_id,
              position)  -- the tag's place in the work's tags, in the author's order
uploads      (id,
              user_id NULL,  -- set null when the account is deleted; the row and its work stay
              r2_key, sha256, bytes, status, lease_until,
              error_stage, error, work_id NULL, created_at,
              quota_counted_at NULL)  -- set when confirm counted it against the daily quota, once;
                                      -- `pending` with this NULL is an open upload (Orphaned uploads)
reports      (id, work_id, reporter_id, kind, body, status, created_at)  -- reporting needs an account;
                                                  -- kind includes wrong_version ("This version is wrong");
                                                  -- no FK on reporter_id: a deleted account's report still counts
takedowns    (id, work_id, requester, basis, status,
              resolved_by,  -- no FK: who resolved it stays after the account is deleted
              created_at,
              signature, infringing_material, good_faith, accuracy_authority,
              incomplete)  -- a DMCA notice: basis is the copyrighted work, requester the contact
                           -- information; incomplete when a 512(c)(3)(A) element is missing;
                           -- status: pending, rejected, or removed (approved, which puts the work on the takedown list)
requests     (id, kind, work_id NULL, pseud_norm NULL,
              pseud_typed NULL,  -- for the removal list: the pseud as typed, cleaned like pseud_norm but with its case kept; NULL on an opt-out from before the list, which is never listed
              contact_email, statement, status, ip_hash, confirm_token_hash NULL, confirm_sent_at NULL,
              confirmed_at NULL, created_at)      -- kind: remove_work | opt_out; status: pending, rejected, approved; a request
              -- hides nothing until confirmed_at is set by the emailed link (the token is
              -- kept only as a hash, cleared on confirm); rows from before that count as confirmed.
              -- contact_email, ip_hash and statement are kept until the site closes, then deleted;
              -- not erased on request (see Decisions so far, Requester data)
request_works (request_id, work_id)  -- written whenever a request hides a work, so a reversed
              request restores exactly those
optouts      (id, pseud_norm, ao3_user NULL, request_id, active, created_at)  -- checked at ingest
listed_pseuds (pseud_norm PRIMARY KEY,  -- one row per pseud on the removal list
              request_id,        -- the approved opt-out whose pseud_typed is shown
              listed_at,         -- when the pseud was first approved; indexed
              withheld)          -- the removal list leaves the pseud out
requester_blocks (id, contact_email NULL, ip_hash NULL,
              created_by,  -- no FK: who made it stays after the account is deleted
              created_at)
moderation_actions (id, moderator_id, action, target_kind, target_id, note NULL,
              created_at)  -- no FK on moderator_id (rows outlive the account) or target_id (it
                           -- points at different tables); action and
                           -- target_kind are free text; note is short, never reader data
                           -- or a requester's email
waitlist     (email PRIMARY KEY,               -- trimmed and lowercased; deleted after launch
              confirm_token_hash NULL, confirm_sent_at,
              confirm_count,                    -- confirmation emails sent, 3 at most
              confirmed_at NULL, notified_at NULL,
              unsubscribe_token_hash NULL, created_at)  -- no IP, user agent or referrer
sweep_state  (id,                -- one row: id 1
              after NULL,        -- the R2 key the periodic sweep's next run lists after; NULL starts over
              current NULL,      -- the folder a run is in; still set at the next start, it was killed there
              updated_at)
sign_in_email_counts (address_hash,  -- keyed hash of the address, never the address
              day,               -- the UTC day; (address_hash, day) is the key
              count)             -- earlier days' rows are deleted as requests count (Surge controls)
```

`user.role` is `user`, `moderator` or `admin`. An admin has every moderator
power. The wait list has no admin action: its purge is a local script (Wait list).

A held upload doesn't make its work held: a first upload always goes live (with
the notice if the parser gave review reasons), and a later upload that is held
leaves the work live at its current version. Held is a state of the version
(its upload is `held_for_review`), never of the work, so `works.status` has no
held value.

**Dedupe.** AO3 epubs carry the original work URL
(`archiveofourown.org/works/<id>`) in the preface. That ID is the canonical key.
Later uploads of the same work go through the versioning rules in the EPUB
processor section. Files without an AO3 preface carrying that URL are
rejected in v1, even if the OPF names an AO3 work. Byte-identical
re-uploads are caught at `/complete` by the file's SHA-256: the upload is marked
`duplicate` straight away, with no ingest run and no second copy kept
(Ingestion pipeline, step 3). That check sees the file as it was at confirm: one
swapped afterwards for a file already in the archive goes through ingest and the
versioning rules, with its original kept. An ingested upload's hash, which later
uploads are matched against, is that of the bytes ingest read (EPUB processor,
step 2); uploads ingested before this was added keep confirm's, with no backfill.

**Tags.** AO3's tag wrangling (canonical tags and synonyms) can't be rebuilt in
a week. Store tags exactly as written, plus a normalized form (`name_norm`:
in Unicode NFKC, lowercased, whitespace and punctuation folded) used for matching. Moderators can
merge synonyms later. Relationship tags keep `/` and `&` when `name_norm` is
computed, so "Kirk/Spock" and "Kirk & Spock" are different tags (whitespace
and punctuation beside them still fold away, so "Kirk / Spock" matches
"Kirk/Spock"); other tag types fold them like any punctuation.

**Pseuds.** Opt-outs match on `pseud_norm`, made by `normalizePseud` in
`packages/db/src/pseud.ts`, in this order: Unicode NFKC; drop every
`Default_Ignorable_Code_Point` character; lower-case with `toLowerCase()`; NFKC
again; collapse each run of `White_Space` to one space; trim. The second NFKC is
there because lower-casing can produce a character that NFKC changes again.
This is not full case folding, so `ß` stays. Unlike `name_norm`, punctuation is
kept, so `a_b` and `a b` are different pseuds. The same rule is applied to the
opt-out request and to every byline at ingest (a pseud with nothing left after
the rule is blank, and names nobody). The web Worker and ingest must use the
same Unicode tables.

We accept these misses. Greek final sigma depends on context, so `ΑΣ` and `ασ`
differ. Turkish `İ` doesn't match `i`. Blank-looking characters that aren't
default-ignorable survive (braille blank U+2800, U+FFF9 to U+FFFB). Dropping the
zero-width joiner and non-joiner, and the Hangul fillers, means some different
pseuds share a `pseud_norm`, so an opt-out can hide another author's works. The
database doesn't check that a `pseud_norm` isn't made only of invisibles:
`normalizePseud` is its one writer.

## Ingestion pipeline

1. **Ask.** `POST /uploads` checks the session, Turnstile, the account's ban, the
   daily quota and the declared size (25 MB or less). One call asks for one file or for several
   (at most 10): one `size` field per file, under one Turnstile token. A call
   with good sizes spends one unit per file of both the per-user and the per-IP
   rate limit (a call refused for a bad count or size spends only the first of
   each), and is checked against the quota left today, which it does not count:
   that happens at confirm. A batch larger than the quota left is refused whole, with a
   429 saying how many uploads remain, and one bad or oversized size refuses the whole
   batch, so a refused call writes no `uploads` row. The upload page's script calls it, so a
   signed-out request gets 401 rather than a redirect it can't follow (the
   page itself redirects to sign in), a failed or missing Turnstile token gets 400, a declared size over
   25 MB gets 413, and a spent quota gets 429 with `Retry-After` (Surge
   controls). A request over the per-user or per-IP rate limit gets the same 429,
   counted right after the session check, before the form is read (the rest of a
   batch's files are counted once the form is read, before Turnstile). The reply is
   JSON `{ error, retryAfter }`, and the upload page shows the message. A banned
   account gets 403 with `{ error }` for the whole batch, checked just before the
   quota (Moderation, *Block and ban*), and `GET /upload` shows it a page saying
   it can't upload. A batch that would take the account's open uploads past the cap
   gets 429 (Orphaned uploads). Otherwise it inserts an `uploads` row for each file, all in
   one transaction, and returns a presigned R2 `PUT` URL for each, valid for 10 minutes,
   locked to `Content-Type: application/epub+zip` and signed for the file's declared
   size as `Content-Length`: JSON `{ id, url }` for one file,
   `{ uploads: [{ id, url }, ...] }` for several. R2 presigned URLs support PUT but not
   form POST, and the bucket needs a CORS rule for `rarepair.fans`.
2. **Upload.** The browser PUTs each file straight to R2 and shows each file's
   progress, three at a time so fewer files wait on a URL that lasts 10 minutes (a
   file that still starts too late fails, and another click sends the files not yet
   uploaded). The page's
   script sends with `XMLHttpRequest`, since `fetch` reports no upload progress.
   Each finished PUT is confirmed with `POST /uploads/:id/complete`.
   Uploading needs JavaScript, as every form with a Turnstile check does
   (Turnstile can't produce a token without it); without JS the upload page
   says so (FRONTEND-DISCOVERY, *Where the frontend changes the architecture*).
3. **Confirm.** For a banned account, `POST /uploads/:id/complete` answers 403
   and ends the upload `account_banned` before reading the object. Otherwise it HEADs the object, checks its size,
   and hashes it (SHA-256). An object over 25 MB is deleted and the upload ends `too_large`
   (413). An object of any other size than was declared is deleted with a plain 400, and
   the upload stays `pending` and uncounted for the reaper (Orphaned uploads). If the hash matches an earlier upload that was
   ingested into a work that is `live` or `hidden` (that upload's status is
   `live`, `held_for_review` or `duplicate`, with a `work_id`), the new upload
   is marked `duplicate` straight away, with `work_id` set to that work:
   nothing is enqueued, there is no ingest run, and the object is never copied
   to `originals/`, so no second copy is kept. The uploader sees the "Already
   in the archive" badge with a link to the work. Any other match (an upload
   still `pending` or `processing`, one that was rejected, or one whose work
   was removed) gets no shortcut: the new upload is enqueued like any other,
   and the versioning rules, the same rejection, or (for a removed work) the
   opt-out and takedown checks, then `work_removed`, decide it. Otherwise it
   enqueues `{upload_id}`. The presigned PUT stays valid after confirm, so the
   object can change: on an enqueued upload, the hash stored here stands until a
   job records the hash of what it read (EPUB processor, step 2). A repeat confirm
   of an upload still `pending` hashes the object again and stores that, and a job
   that reads the file afterwards replaces it in turn. An upload marked `duplicate`
   here has no job, so it keeps this hash.
4. **Process.** The ingest consumer handles one upload per invocation (a batch
   size of 1), so a crash in one job has no batch-mate to spend the retries of, with
   retries and a dead-letter queue. See the EPUB processor section below. An
   invocation runs its jobs one after another, so with a concurrency of 2 at most
   two jobs run at once at any batch size. A size of 1 lowers no ceiling: it costs
   one invocation and Postgres connection set-up per upload, and no batch wait.
   Throughput is 2 ÷ seconds per job. No job has been timed on real Queues, so
   this is an estimate: 2 seconds for a small epub (the processor takes well under
   a second on the synthetic epubs in tests; R2 and Postgres add the rest) and 20
   for a 25 MB one with many R2 writes, reasoned from those limits, give 6 to 60
   uploads a minute. A burst past that waits in the backlog, which is what the
   concurrency cap is for, so the concurrency needs no change. The backlog has a
   limit: at those rates the queue's default four days of retention hold about
   35,000 to 345,000 uploads, and a message that expires never reaches the
   dead-letter queue, so its upload stays `pending`.
5. **Track.** The uploader's page polls `GET /uploads/:id` for its status:
   `processing`, `live`, `held_for_review`, `duplicate`, or one of the
   rejection codes below. `held_for_review` and `duplicate` are not
   rejections: the upload is kept (a byte-identical re-upload keeps only its
   row), it just isn't (yet) the current version. An upload that went live
   with review reasons is `live`; the notice is shown on the work, not as an
   upload status.

### EPUB processor

It lives in `packages/epub`. Its functions are pure: bytes in, a parsed work
out. `apps/ingest` is a thin wrapper that handles R2, Postgres and job status.

**Scope for v1.** Only AO3-native exports are accepted. Non-AO3 epubs are
rejected (`not_ao3`), which keeps commercial ebooks out and gives every work a
link back to AO3. FanFicFare files of AO3 works come later, through a second
preface parser. Search covers metadata only: title, author, tags and summary.
Chapter text isn't indexed.

1. **Lease the job.** Queues may deliver a message more than once, so the job starts
   with an atomic `UPDATE uploads SET status='processing', lease_until=…` that
   only matches when the upload is `pending` or its lease has expired. All
   output goes under `works/<ao3_work_id>/<upload_id>/`, so a retry overwrites
   its own files and never touches another run's. The running job renews its lease
   every 15 seconds (the lease is 60) and checks it still holds the upload before each
   stage and each R2 write. A job that finds it lost stops, logs it and writes or
   deletes nothing more; the fenced write in the Postgres transaction has the last word.
2. **Unzip with limits.** Read the object from R2 (25 MB or less) and hash the
   bytes read (SHA-256). That hash replaces the one on the row in the job's fenced
   ending write, whatever the job ends as, a rejection or a retry included. A job
   that lost its lease or died before that write records none, so the row holds
   the last recorded read's hash. A hash that differs from confirm's isn't refused
   or shown to the uploader, and no locked copy of the file is made: the job
   handles what it read. An attempt that ends without a whole read (the object is
   gone or over the limit, the account is banned first, or the read fails), and the
   dead-letter consumer, leave the hash as it is: confirm's, until a job has
   recorded a read. Check the zip's file index before decompressing anything:
   - at most 2,000 entries
   - at most 40 MB uncompressed in total
   - at most 20 MB per entry

   Count bytes during decompression as well, because a zip can lie about its
   sizes. Unzip with `fflate`. Each problem has one code, here and while the
   documents are parsed in the next steps:
   - **`zip_bomb`:** more than 2,000 entries, or more than 20 MB in one entry
     or 40 MB in total, whether declared in the index or found while
     inflating.
   - **`not_epub`:** the file isn't a zip; the `mimetype` entry is missing or
     isn't `application/epub+zip`; an entry name is unsafe (`..`, a leading
     `/` or a drive letter) or appears twice; the central directory disagrees
     with the local headers; the archive is ZIP64; `META-INF/container.xml`
     or the OPF is missing; an XML file declares entities (`<!ENTITY`); or
     `container.xml`, the OPF or the NCX isn't well-formed XML.
   - **`too_large`:** the input is over 25 MB, or the documents together pass
     the parser's node budget (300,000 elements and text nodes).
   - **`parse_failed`:** elements are nested 256 or more deep (the root element is level 1), or a content
     document (XHTML) fails to parse in some other way. Malformed package XML
     (container, OPF, NCX) is `not_epub`, above.
3. **Index files.** `META-INF/container.xml` points to the OPF, which gives the
   metadata, the file list, the reading order and the table of contents (NCX
   or EPUB3 nav). Workers have no `DOMParser`, so XML is parsed with
   `fast-xml-parser`. XHTML goes through `HTMLRewriter`.
4. **AO3 preface.**
   - **Provenance:** the work URL (`archiveofourown.org/works/<id>`) must come
     from the preface's "Posted originally on the Archive of Our Own" line. If
     that line or its URL is missing, the file is rejected with `not_ao3`,
     even when an AO3 work URL appears in the OPF identifier or source: a file
     with no AO3 preface isn't an AO3-native export. When the OPF identifier
     or source also holds an AO3 work URL, it is cross-checked against the
     preface's; a mismatch gives the `work_id_mismatch` review reason (step 5).
     A native file whose preface has no `Rating:` gets the `missing_rating`
     review reason.
   - **Fields are matched by label text, never by CSS class.** AO3 builds
     epubs with Calibre, which may rename classes. Read the `dt`/`dd` pairs
     under labels such as `Rating:`, `Archive Warning:`, `Category:`,
     `Fandom:`, `Relationship:`, `Character:`, `Additional Tags:`,
     `Language:`, `Series:` and `Stats:`. Summary, notes and end notes come
     from their headed blocks.
   - Unknown labels are kept in a `raw_meta` JSON column, so we never lose
     data the parser doesn't understand yet.
   - **Whose byline is checked.** Every name the file gives in a form we can read: the preface's named
     authors (a link with nothing visible in it, such as a space or a
     zero-width character, names nobody) and every OPF `dc:creator` the
     preface doesn't already name, so a blank or partial preface byline never
     hides the author. A byline with no profile links is cut at commas (an Oxford "and"
     included) and at a lowercase " and "; each piece is checked, but not the
     whole text (an opt-out for a pseud that itself holds ", " or " and " is
     matched only through an OPF `dc:creator` that holds it whole). Other
     separators ("&", ";", "AND") cut nothing. So is a `dc:creator` that holds several
     names, whole and cut. Cutting is a guess: nothing says "Salt and Pepper"
     isn't one pseud, so a cut byline gets the `byline_ambiguous` review
     reason, and a file with no name anywhere gets `byline_missing`. Both go
     live like any upload, new work or update, with the notice and a place in
     *Works to check* (step 5); neither is a hold. The "Anonymous" an
     unlinked byline gives is a placeholder, not a pseud: it is not checked and
     not flagged, but a profile link whose user is "Anonymous" is a name. A
     name the opt-out table refuses to hold (a NUL byte, say) ends the upload
     `parse_failed`, recorded; a list that can't be read at all is retried.
   - Then check the opt-out and takedown lists, before anything is written. A
     match rejects the file with
     `opted_out`. The takedown list holds the AO3 work IDs of works a
     moderator removed after a DMCA notice; a notice no moderator has acted on
     isn't on it, so it doesn't block uploads.
5. **Chapter boundaries.** Files in the reading order are not chapters.
   Calibre splits documents by size (`*_split_NNN.xhtml`), so one chapter can
   span several files and one file can hold several chapters. Ways to find the
   real boundaries, in order of preference:
   1. Table-of-contents entries (`file.xhtml#anchor`). Stream the files in
      order and start a new chapter buffer when the anchor's element appears.
   2. AO3 chapter headings, if the table of contents is missing or doesn't
      match.
   3. One chapter per file, as a last resort. This adds a review reason.

   The parsed chapter count should match the count in the preface `Stats:`. If
   it doesn't, that is a review reason too.

   **Review reasons** are things the parser could do but isn't sure of: a
   one-chapter-per-file split, a chapter count that disagrees with `Stats:`,
   content outside the chapters, a manifest item it couldn't read, a missing
   rating (`missing_rating`) or title, a title or work ID that differs between
   preface and OPF (`work_id_mismatch`), a byline that is empty
   (`byline_missing`) or can only be cut into names by a guess
   (`byline_ambiguous`), and so on. They are stored on the version (`work_versions.review_reasons`).
   A version with review reasons still goes **live**, with a notice on the work
   and reader pages: "Chapters may be imperfect; a moderator will check." The
   work also lands in the moderators' *Works to check* queue, and approving it
   there clears the notice. This is not `held_for_review` (step 7), which keeps
   a newer upload off the site entirely.
6. **Sanitize.** Apply the allowlist below to chapter bodies, the summary and
   the notes. Images listed in the manifest are checked by their file signature
   (PNG, JPEG, GIF or WebP only), capped at 5 MB each, stored by SHA-256 under
   `works/<ao3_work_id>/img/`, and their links rewritten. SVG, fonts and
   stylesheets are dropped. Images deliberately sit outside the per-upload
   prefix: keyed by content hash, they are shared by every version that uses
   them, a retried job rewrites the same keys, and a data centre can cache them
   for 12 hours (*Edge cache*). Images no version references (say, from a job that failed
   before its transaction) are removed by a periodic sweep, and all of them go
   when the work is removed; whatever the removal's purge missed, the sweep
   deletes on a later run (*Removal really removes*).
7. **Versioning.** Each work is keyed by `ao3_work_id`. The first upload
   creates the work. A later upload:
   - **replaces the current version** only if it is newer (more chapters or a
     later Updated, Completed or Published date) **and** the chapters both
     versions share come out as near-identical text after sanitizing. Small
     edits are allowed; each shared chapter's normalized text is compared and a
     similarity threshold applies (below).
   - **is held for review** (`held_for_review`) if it is newer but its shared
     chapters differ, or if its tags or authors changed. A held version is
     never public: the work keeps serving its current version, the held one is
     listed only for its uploader (My uploads) and for moderators (*Works to
     check*), and only a moderator's approval makes it current. This is not a
     guard against someone editing an epub to tamper with a work: a replace
     whose shared chapters are near-identical and whose tags and authors match
     goes live with no hold, whatever else changed (a link, an image, the
     title, summary or notes, a date). The check is readers' "This version is
     wrong" reports and a moderator's "Make current" (operator ruling,
     2026-11-05). Nothing bounds the held versions per work: the same changed
     content in differently zipped files stores another held version (rows,
     chapters, files) and another review entry each time, and only the
     uploader's daily quota limits it. We accept that.
   - **is marked `duplicate`** if it isn't newer. Its original is stored but
     not used, and its fragments are swept (step 8).
     This is a status, not a rejection: the uploader sees "Already in the
     archive" with a link to the work. A byte-identical file never gets this
     far; `/complete` marks it `duplicate` (Ingestion pipeline, step 3).

   A newer, consistent upload with review reasons (step 5) still replaces the
   current version, and goes live with the notice. Review reasons never make an
   upload `held_for_review`; only the checks above do.

   Nobody's upload gets special treatment, the author's included. We can't
   tell who the author is while AO3 is down.

   The decision is a pure function of the two versions' facts
   (`apps/ingest/src/versioning.ts`, never the uploader). Its defaults are
   fixed in that file, and the similarity threshold is a named, per-call
   option:
   - **Newer** means more posted chapters (the count of chapters in the file,
     not the planned total), or a later date: Updated, else Completed, else
     Published, at day granularity (anything that is not a real `YYYY-MM-DD`
     date counts as missing). Equal chapter counts and equal dates are
     not newer, and a missing date never makes an upload newer. An upload with
     fewer chapters but a later date, or more chapters but an earlier date, is
     newer.
   - **Near-identical** means every chapter number both versions have, paired
     by chapter number, is at least
     90% similar (`SIMILARITY_THRESHOLD`, 0.9). The chapter's sanitized text
     is normalized by removing markup and collapsing whitespace; case and
     punctuation count. Equal normalized text is identical, and only a
     mismatch is measured: the Dice coefficient of the two texts' word pairs.
     A short chapter has little room: one changed word in under 20 breaks 90%,
     so it is held. Titles, summary and notes are not compared, and a chapter
     number only one version has is not compared either.
   - **Tags and authors changed** compares sets, not order: tags by type and
     normalized name (`name_norm`), every type including rating and warning;
     authors by normalized pseud and AO3 user (where there is one).
   - **Known gaps, kept as built (operator ruling, 2026-11-05).** An edit that
     changes only an attribute (a link's target, an image) is invisible to the
     text comparison. An upload with fewer chapters but a later date replaces
     the current version, and the chapters it drops are not compared. A replace
     with title, summary or notes changed alone replaces. The 90% slack is per
     chapter, with no bound across the work. An undated current version can't
     be superseded by a same-count upload with a date. A replace with an earlier
     date writes it, so `works.updated_at` can move backwards.
   - **Not newer is a `duplicate`** even when its tags or authors changed.
     When several checks fail, the held reason is the first of: chapters, tags,
     authors.

   Every version is kept, so a bad replacement can be rolled back. Only
   moderators roll back: a work's admin page lists every version (date,
   uploader, chapter count) with a "Make current" action that repoints
   `current_version_id`. Readers who spot a bad version report it as "This
   version is wrong" (Author requests & takedowns, Reports).

   **Where a work's columns live.** Each version keeps its own copy of the
   columns that describe it (title, summary, rating, language, words,
   complete, dates, raw metadata, chapter count and total, tags and byline),
   as ingest read them from its file, with NULL for a field the file lacked
   (an empty title is none; the word count, updated date and completion are
   derived, as the work's always were, when the file doesn't state them); a
   held version also keeps its hold reason. `works`, `work_tags` and
   `work_authors` describe the current version only, so every reader (the
   work page, listings, search, and the next upload's decision, which reads
   `works.updated_at`) sees the current version. They are copied from the
   version whenever it becomes current: on a first upload, on a `replace`, on
   "Make current", and when a moderator approves a held
   version. The copy is
   `copyVersionToWork` in `packages/db`, in the transaction that moves the
   pointer: each non-NULL field of the version is copied, a NULL one keeps
   the work's value (so a replace whose file lacks a field never blanks the
   stored one, and the title is never NULL), except the chapter count and
   total, which are always the version's (a version that states no total
   leaves the work's NULL, and its card reads "12/?"), the byline and tags are
   rewritten from the version's own unless those are NULL, and the search
   text is refreshed.
8. **Save, in order.** Write chapter fragments and images to R2. Then run one
   Postgres transaction that upserts the work, adds the version, chapters and
   tags, and points `current_version_id` at the new version. Set the work
   `live` last. If the job fails before the transaction, R2 is left with
   orphaned files under its `<upload_id>/` prefix, which the sweep deletes once
   the prefix is a day old and no version points at it. A
   job that fails for good and can record it goes to the dead-letter queue as
   `parse_failed`, with the stage and error recorded on the upload row.

   **A consumer on the dead-letter queue catches what no job recorded,** among the
   messages that reach it. (A message that expires doesn't, and #629 tracks a
   crashed job's retry being acked under its own lease.) A job that dies on every
   delivery (a crash, a kill at a platform limit) or whose ending write fails on
   the last attempt records nothing, and an outage of Postgres longer than the
   ingest queue's retries, about 6 minutes, dead-letters uploads no job has run, whose
   files may be fine (#630). The ingest Worker also
   consumes `ingest-dlq`: an upload whose message arrives there is set
   `parse_failed`, with the stage unknown (`error_stage` empty, `error`
   `dead_lettered`), and the existing failure message tells the uploader to try
   again. It also stops the sweep skipping the work as in flight (#440). The
   write matches only what `claimLease` would: `pending`, or `processing` with an
   expired lease. Anything finished stays as it is, the job's own stage and error
   included, so a repeat delivery is harmless. Under a live lease the row is left
   and the message retried: a job may yet end it, or may have died a moment
   before its message moved, and a later delivery finds it ended or expired.
   A duplicate of the message that is still retrying then finds the upload ended,
   and a job still running on a lapsed lease loses it and saves nothing, so the
   uploader is told to try again even if that job might have saved it.
   The consumer handles one message per invocation, one invocation at once, and
   retries every 120 seconds, past the 60-second lease, for an hour (30 retries),
   with a 10-second limit on connecting and on each query, so a stalled connection
   fails and retries. That outlasts a short Postgres outage and a job running to the 15-minute
   wall-time limit. After a longer outage the message is deleted, with no
   dead-letter queue behind this one, and the upload stays as it was: there is
   no redrive, and the uploader uploads the file again. Add one only if a real
   outage shows it's needed (operator ruling, 2026-11-05). The consumer writes nothing to R2, so an original the
   job had stored stays (case 1 below). The backfill queue already has a batch
   size of 1, and needs no such consumer: a failed backfill leaves the work's
   current version as it was.

   Whether a crash charges an attempt to messages already acked in the same batch
   is unsettled: Cloudflare's docs say an explicit ack isn't redelivered when a
   later message fails, and don't describe a hard crash, and no check has been
   run on real Queues. A batch size of 1 leaves no batch-mate for it to charge, so
   ingest doesn't depend on the answer.

   **A refused upload's original is deleted.** Once the job has recorded a
   refusal (any rejection code, `account_banned` included, and a job that
   failed for good; not `work_removed`, whose save already deleted it), it
   deletes the one key `originals/<upload_id>.epub`, so the content host no
   longer serves it from R2. The content host serves an upload's original only
   when the upload is `live` or a `duplicate` (a refused upload gets 404 whatever its
   work's status), so a refused upload's original, which never went live,
   is not served, and no edge copy is expected to exist for it. The delete comes
   after the fenced write that ends the upload, and only when that write
   matched: a job that lost its lease deletes nothing, and an ended upload
   can't be claimed again, so the delete never removes a file a takeover job
   stored for a version that goes live. A retry that ends refused (an opt-out
   or a ban that arrived between attempts) deletes what the earlier attempt
   stored by the same rule. The delete is best effort: a failure is logged
   (the upload id, a count, never the file) and changes neither the upload's
   status nor the message's verdict, and a crash between the ending write and
   the delete leaves the file, which nothing removes yet (the sweep covers
   `works/` objects and the `uploads/` expiry is a lifecycle rule; neither
   touches `originals/`, except that the sweep deletes the original of each upload
   whose prefix it finds under a removed work's folder). Four cases leave an
   epub that nothing deletes, tracked in https://github.com/rare-pair/app/issues/592
   (the operator chose a ticket over fixing them now): (1) an upload whose job
   stored the file and then dies on every delivery, or whose ending write fails on
   the last attempt, so only the dead-letter consumer ends it and nobody deletes the
   original (the sweep still finds it if the work is later removed, while the
   upload's prefix is there), or a Postgres outage that outlasts that consumer's
   retries, so it stays `processing` and the sweep skips the work as in flight;
   (2) a duplicate's epub after the ordinary sweep removed its prefix and a removal's
   delete then failed, because the sweep finds originals only from folder prefixes and
   never visits an emptied folder again; (3) a crash between the ending write and
   this delete, or that delete failing, which can leave an opted-out or banned
   upload's file; (4) an upload with no `work_id` whose prefix is gone, which can't be
   tied to its work. The content host refuses all of these (#579), so they can't be
   downloaded; they are only stored. Fragments and images of a
   refused upload are the sweep's. A refused upload has no version, so this
   leaves the keep-for-re-sanitize decision intact. A `duplicate`'s original
   is kept (below).

   **A refused upload's staging file.** When the job ends an upload `opted_out` or
   `work_removed`, it also deletes the raw file at the upload's own key under
   `uploads/`, by the same rule: after the ending write, only when that write
   matched, best effort, and logged by upload id and count. An attempt that will be
   retried keeps it, and so does an ending write that fails, since the next attempt
   reads it. `opted_out` covers a takedown too. Every other refusal the job ends
   leaves the file to the 7-day expiry.

   A later upload of a known work is decided in the same transaction, from
   facts read before it (the current version's chapter text comes from R2,
   never read under a lock). A `replace` adds the version and chapters, then
   moves `current_version_id` with one compare-and-swap (`update ... where
   current_version_id = <the one read>`), then copies the new version onto
   the work (its columns, keeping the stored value for a field the file
   lacks, its byline and tags) and refreshes its search text; the upload is
   `live`. A job that loses the swap rolls back, reads the work
   again and decides again, so two uploads at once leave one current version.
   Before the current version is read, and before any R2 write, the job checks
   the work's status: an upload of a `removed` work is refused as
   `work_removed`, with nothing written and no `work_id`. (A file whose AO3
   ID is unusable or that has no chapters is refused earlier, as
   `parse_failed`.) The transaction checks the status again, so a work removed
   while the job ran is never versioned. Its upload is then `work_removed` too,
   and the job deletes the R2 files it had written: its `originals/` file, and
   the work's `works/<ao3_work_id>/` folder (only the upload's own fragments, if
   the work was restored in the meantime; its images then stay for the sweep),
   since the removal's purge may have run before those writes. What a failed
   clean-up leaves under a removed work's folder, the sweep deletes (*Removal
   really removes*). The same
   clean-up runs when a redelivery reaches the save and finds the work removed,
   so a clean-up that failed is repeated (not on the last attempt, nor when the
   takedown list now ends the upload earlier). A removal that purges the current version's
   fragments while the job reads them is the same refusal.
   A `hold` adds the version and chapters and leaves the work, its byline and
   tags alone (the version keeps its own columns, `tags`, `authors` and
   `hold_reason`); the upload is `held_for_review`. A `duplicate` adds no
   version; the upload is `duplicate`, with its `work_id` set and its
   original kept under `originals/`. No version points at its `<upload_id>/`
   fragments, so the periodic sweep deletes them, like any orphaned prefix,
   on its first pass over the work after they are 24 hours old. A replace never changes the work's status: a hidden work stays so (a
   removed work takes no upload). Only a work's first upload sets it `live`.

   **The re-sanitize backfill** is a third kind of save, decided by "same
   original, new sanitizer", not by the uploader-facing rules of step 7, and
   no `uploads` row is involved (operator ruling, 2026-11-01). After a
   sanitizer fix the operator runs `scripts/backfill.mjs`, which puts one
   `{ work_id, version_id }` message for each `live` or `hidden` work's current
   version on the `ingest-backfill` queue; `removed` works are left out, as
   their files are gone. The ingest Worker consumes it, one work at a time,
   and acks the message with no new version when the work is removed (it
   clears the work's `works/<ao3_work_id>/` folder again, for an earlier
   attempt that raced the removal) or its current version is no longer the
   message's (a redelivery after the commit, a moderator's make-current or a
   newer upload). Otherwise it reads the version's original,
   `originals/<id>.epub` for its `upload_id`, or its `source_upload_id` when
   it is itself a backfill version, runs the processor as
   it now is, checks the opt-out and takedown lists and the AO3 ID, and
   writes a **new version**: its fragments under a prefix of its own,
   `works/<ao3_work_id>/<version id>/`, its images under `img/`, and no second
   copy of the original. Existing fragments are never rewritten, so every
   cached fragment keeps its key (#441). One transaction adds the version, with
   `source = backfill` and `source_upload_id` naming the upload it was
   re-made from (`upload_id` is NULL), and moves `current_version_id` to it
   with the same compare-and-swap as a replace, then copies it onto the work.
   It never calls `decideVersion`: the same file would be a `duplicate` there.
   The work's summary is the new version's even when it has none. A
   work removed while the job ran has its `works/<ao3_work_id>/` folder
   cleared again, since the job may have written after the removal's purge.
   The work's status is left as it is. `checked_at` carries over only when the
   re-made version has the same review reasons. A file the processor now
   refuses is logged by its code and acked, leaving the current version
   alone; an R2 or Postgres failure is retried, then dead-lettered to
   `ingest-backfill-dlq`. A message whose version is no longer current is
   acked even when the work's new current version predates the fix: rerun the
   script for it. Only current versions are re-made, so an older version made
   current again, or a held version approved later, still has its old
   fragments. Nothing records
   which sanitizer made a version, so a rerun re-makes every work again (#464).
   The script pushes 100 messages a call, at most two calls a second, under
   the Cloudflare API's rate limit. The consumer re-makes one work at a time,
   so a large archive takes days: create `ingest-backfill` with a message
   retention longer than the run (Queues keep a message four days unless
   configured, at most 14), or run the script in slices with `BACKFILL_AFTER`,
   since a message that expires unconsumed is dropped without a trace.

**Rejection codes:** `not_epub`, `zip_bomb`, `too_large`, `not_ao3`,
`opted_out`, `parse_failed`, `work_removed`, `account_banned`. Each one shows a plain-language
message to the uploader. `work_removed` is the upload of a work a moderator or
its author removed, checked after the opt-out and takedown lists and before
the current version is read. `account_banned` is an upload by an account a
moderator banned, or one since deleted (Auth, Deleting an account) (its meaning to the uploader: the account can no longer
upload): the ban sets it on the account's `pending` uploads (and a confirm sets
it on one written after the ban), and ingest sets it on a job whose uploader is
banned, checked before the file is read and again, with a key-share lock on the
account's row, in the save's transaction. A save that took that lock first
finishes, and its upload counts as finished. A ban the save's check catches
leaves the fragments and images the job had already written for the sweep, and
deletes the upload's `originals/` file like any refusal (step 8). Step 2 lists which problem gives which of the first three.
`not_ao3` covers any file without an AO3 preface "Posted originally" line,
including one whose AO3 work URL is only in the OPF (step 4). `opted_out`
covers the opt-out list and the takedown list of moderator-removed works.
`parse_failed` also covers a job that fails for good, whether the job recorded
it or the dead-letter consumer did (step 8). (`held_for_review`
and `duplicate` are statuses, not rejections, and review reasons are neither. Nor is
`over_quota`: the status of an upload whose confirm was refused 429 because the
account's daily quota was spent, whose object is deleted.)

**Testing.** `HTMLRewriter` exists only in the Workers runtime, so the
`packages/epub` tests run in it (`packages/epub/vitest.config.ts`). Fixtures are
about 50 real AO3 epubs covering:
- older and current AO3 export formats
- one-shots and works with many chapters
- works with images and work skins
- anonymous works and series members
- non-English and right-to-left text

There are also hand-built bad files: zip bombs, path traversal, a missing OPF,
a chapter count that doesn't match `Stats:`, an AO3 work URL only in the OPF,
and XSS payloads in every field.
The parser must give the same output whenever it runs, so a fixture's output
can be snapshotted.

### Sanitizing (security requirement)

- Allowlist only: `p, br, hr, em, strong, i, b, u, s, sub, sup, blockquote, h1–h6,
  ul, ol, li, dl, dt, dd, table, thead, tbody, tr, th, td, span, div, a, img, abbr,
  small, center` and a short list of attributes (`href`, `src`, `alt`, `title`,
  `colspan`, `rowspan`, `dir`, `lang`, `align`). `class` and `id` are dropped:
  Calibre's class names mean nothing to our styles, and ids could clash with
  the page's own.
- Drop `script`, `style`, `iframe`, `object`, `embed`, `form`, `svg`, `math`
  (also under a namespace prefix such as `svg:script`), together with
  everything inside them, plus every `on*` attribute and inline `style`. AO3
  work skins are lost, which is an acceptable trade-off.
- `href` may only be `http(s)://` or a link to another chapter of the same work,
  rewritten to our own reader URL. External links get
  `rel="nofollow noopener noreferrer ugc"`, so following one doesn't tell the
  target which work a reader was on.
- `img src` must point to an image inside the epub, rewritten to its R2 key on
  `content.rarepair.fans`. Remote images are dropped, which also stops them being
  used to track readers.
- Implementation (`packages/epub`): `HTMLRewriter` is used only as a
  tokenizer, to build a small tree with a depth cap and a node budget. The
  output is then written from scratch by a serializer that emits only
  allowlisted elements and attributes, escaping all text and attribute values.
  Nothing from the input reaches the output except through that serializer, so
  the serializer is the security boundary. Dropped elements are left out with
  their contents; unknown wrapper elements are unwrapped so their text
  survives. It is tested against an XSS corpus in chapters, the summary and the
  notes; fuzz it further before launch.

## Reading

- **Work URLs use the AO3 work ID:** `:id` in `/works/:id` (and every path under
  it) is `ao3_work_id`, not the internal `works.id`. It's stable, it mirrors
  AO3's own URLs, and it's already known when ingest writes chapter fragments
  (before the Postgres transaction), so internal chapter links can be rewritten
  in the same pass. It also makes the wind-down redirect a one-line rule.
- The reader page is server-rendered on the app: `/works/:id/chapters/:n`. The
  web Worker reads the sanitized chapter fragment from R2 through its binding
  and renders it inline in the page, inside `<article class="chapter">`. There
  is no iframe and no client-side epub engine, so Ctrl+F, printing, text
  selection, screen readers, in-browser translation and reader extensions all
  work normally (a tool that fetches the page on its own server and identifies
  itself is refused: Crawlers and agents). Pages also stay fast on cheap phones.
- **Strict CSP on every app page** (a fresh nonce per response):
  `default-src 'self'; script-src 'nonce-{n}' 'strict-dynamic'; style-src 'self';
  img-src 'self' https://content.rarepair.fans; object-src 'none'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'`. Injected markup can't guess the
  nonce, so any script that gets past the sanitizer won't run. Session cookies
  are `HttpOnly`, so scripts can't read them anyway.
- **Pages with a Turnstile check** (sign-in, upload, `/remove`, `/dmca`, and the
  coming-soon page at `/` while `PRELAUNCH` is on, with `/waitlist`, where a
  refused join shows its form again) add exactly one
  allowance, `frame-src https://challenges.cloudflare.com`, for the challenge
  iframe. Turnstile's `api.js` loads through a nonced `<script>`, which
  `'strict-dynamic'` already covers. Reader and work pages never get it.
- **The upload page alone also adds** `connect-src 'self'
  https://<R2 account id>.r2.cloudflarestorage.com`, the one host its script
  PUTs files to. It is built per request from the Worker's `R2_ACCOUNT_ID`
  (and left out if that isn't plain letters and digits, so the upload fails
  closed). Every other page keeps `default-src 'self'` for connections.
- **HTML pages aren't left to a shared cache with their nonce.** The CSP
  middleware sets `Cache-Control: private, no-store` on every HTML response
  that has no `Cache-Control` of its own, so a zone Cache Rule or a proxy can't
  hand one visitor's nonce to the next. A page that sets its own keeps it,
  such as the tag listing's short private cache.
- **What's left without an iframe:** content made to look like our own
  interface, such as a fake "log in again" box or a lookalike link. The
  sanitizer already blocks the main tools for that by stripping `<form>`,
  `<style>` and inline `style`, and by limiting links. The reader CSS also sets
  `.chapter { contain: content; }` and keeps `position` locked inside it. Treat
  any new trick here as a sanitizer bug.
- **Chapter notes are styled by position.** The sanitizer drops `class` and
  `id`, and the data model keeps no separate notes, so the reader CSS styles a
  chapter's notes (#205) by structure: a label `<p>` followed by a
  `<blockquote>`, first in `article.chapter` (chapter notes) or last (end
  notes), flat or inside one wrapper `<div>`. Both are smaller and muted. The
  accepted false match: a real quote block placed the same way (a paragraph then
  a blockquote opening or closing a chapter) gets the same style, and so does
  the paragraph that introduces it, since it has the label's shape. That's a
  design choice, not a bug to fix with a class hook.
- **We can re-sanitize everything.** Originals are kept in `originals/`, so
  when a bypass is found we fix the sanitizer and re-run ingest on every stored
  work from a backfill queue. Each re-run work gets a new version under its own
  prefix, made current; old fragments are never rewritten (EPUB processor,
  step 8, The re-sanitize backfill).
- **Caching.** Fragments in R2 never change once written, since each version
  has its own prefix. The Worker caches them with the Cache API. Reader
  settings (font, spacing, theme) come from a cookie. The server writes them as
  `data-*` attributes on `<html>`, or a script flips the attributes when they
  change, and the stylesheet's CSS variables key off those attributes. Inline
  `style` is never used, since the CSP blocks it. So the same chapter fragment
  serves every reader. Pages
  for signed-out readers can get a short edge cache, apart from the nonce: use
  a cached template with the nonce swapped in, or cache only the fragment.
  A signed-out chapter page is cached at the edge for 60 s, and the cached copy
  is served before the work's status is checked (the warnings screen check
  still comes first). The status is read before the page is cached, so a hide
  can show up to 60 s after the page was cached, which can run slightly past 60 s
  from the hide itself. The page's own reads go through the cached Hyperdrive
  connection (see *Connections*), which adds up to about 75 s more, so in all a
  hide, a removal or a change can take about 135 s (a little over 2 minutes) to show on
  a chapter. The work page, `/full`, listings, search and the home page have no edge
  cache of this kind, so for them it is the connection's window, up to about 75 s, plus
  the browser cache a response sends: a tag listing's `private, max-age=60,
  stale-while-revalidate=60` adds up to 120 s in the same browser, so about 195 s.
- **Warnings screen.** A work rated Mature or Explicit, or carrying archive
  warnings, or marked "Choose Not To Use Archive Warnings", or with no rating
  at all, shows an interstitial with its rating and warnings the first time a
  reader enters its reading pages, from any entry point: chapter 1, a direct
  link to a later chapter, or `/full`. "Continue" goes on to the page they asked for. Having
  seen it is then remembered for that work in a session cookie, so other
  chapters of the same work open directly until the browser session ends. The
  check runs before any edge-cached page is served. A work with no rating (the
  `missing_rating` review reason) is shown as "Not Rated" on its card, work
  page and warnings screen, and always gets the screen, as if it had warnings.
  A signed-in reader can turn warnings off, from a checkbox on the screen or from
  `/settings/reader`; the choice is stored on their account (`user.warnings_off`), not
  in the settings cookie, and skips the screen for every work that would show it, a
  work with no rating included. Signed-out readers can't turn them off.
- **"May be imperfect" notice.** When the current version has review reasons
  that no moderator has cleared (EPUB processor, step 5), the work page and
  every reader page show one line: "Chapters may be imperfect; a moderator will
  check."
- The reader has font size, line spacing, light/dark/sepia themes, and a
  one-page "entire work" view. These settings are stored in a cookie. (The
  warnings choice above is the exception: it lives on the account.)
- Signed-in users get their reading position saved to KV (the `POSITIONS`
  binding), keyed `pos:<user id>:<AO3 work id>`, with a value of the chapter
  number (none on the entire-work page) and a scroll percentage. A script on
  the reading pages saves it five seconds after the reader stops scrolling, and
  when the page is hidden. The save keeps the furthest point within a chapter, and
  within the entire-work page: the endpoint reads the stored value and keeps the
  larger percentage when the chapter number is the same (none against none counts as
  the same), so scrolling back up and leaving, or rereading from the start, never
  lowers what the Continue link offers. Only a different chapter number replaces the
  stored place, whatever its percentage, and going between a chapter and the
  entire-work page counts as a different place too. The read and the write are not
  atomic, and KV can return a value a little stale from another location, so two
  tabs, or two saves from different places in quick succession, can race and the
  last write wins: the furthest point is kept in practice, not guaranteed. It
  expires after a year, or goes with the account (Auth, Deleting an account). The
  work page's "Continue where you left off" link names the chapter in its path and
  the percentage in a `#pos=` fragment, which the script reads once to scroll back;
  the work page itself never moves the reader.
- "Download original epub" serves the file from `originals/` with
  `Content-Disposition: attachment` from `content.rarepair.fans`. It's never
  displayed inline. The link names the current version's upload, or for a
  backfill version the upload it was re-made from (`source_upload_id`). The
  download never meets the warnings screen: the content origin has no cookies and
  the link isn't gated, so a Mature, Explicit or warned work can be downloaded
  without seeing it. We accept that.

### Crawlers and agents

Fic text is kept from clients that say they are automated, without making readers
prove anything. The protected paths are `/works/:id/chapters`, its chapter pages
and `/full` on the app, and `/works/:id/img/*` and `/originals/*` on the content
origin. Work pages, listings and search stay open, so people can still find works.

- **Who is refused.** A request with a `Signature-Agent` header (Web Bot Auth,
  which isn't verified, since announcing itself is enough) or with a `User-Agent`
  on the crawler list gets a **403** on a protected path, whatever its session. The
  list is one source both Workers are built from. It names products, matched as plain
  case-insensitive text, with no word as broad as `bot`, which would catch phones whose
  model names hold those letters. In the Worker, the www 308 and the pre-launch redirect
  still come first, since neither serves any text. The zone rule below runs before the
  Worker, so a known bot it blocks gets its block page even before launch. Both Workers share the list. The check runs ahead of the
  session lookup, the edge cache and the work's status, so a refusal costs no
  lookups and doesn't itself show whether a work is live, hidden or removed (the work
  page, which stays open, still answers 451 or 410). Paths are checked in the decoded
  form the router matches, so percent-encoding gets no way around them. On the
  content origin it answers before `caches.default`, with no body and no cookie.
- **Only what a client declares.** Nothing is refused for looking headless, for its
  IP range or for its request rate: those would catch the real-browser journeys and
  assistive tools, and a high rate only meets the throttles below. Managed Challenge and JavaScript detections are out too, because
  reading must work with JavaScript off and reader pages allow no third-party frame.
- **Zone config.** One custom rule blocks `cf.client.bot` on each host's protected
  paths, which covers search engines as well. Those requests get Cloudflare's own block
  page, never reach a Worker, and show only in Security Events. Bot Fight Mode, Super Bot Fight Mode
  and Browser Integrity Check are off (Hosts). AI Crawler and Agent access policies stay on
  allow and Bot Preference Sync stays off: both act on the whole zone, so they would
  also block work pages, and the Workers' `robots.txt` stays the only source.
  AI Crawl Control is for watching which crawlers come, and for adding to the list.
  `request.cf.botManagement` isn't used, since it needs Enterprise Bot Management.
- **Signals.** `/robots.txt` on the app disallows the chapter and `/full` paths, and
  `/search` so that crawlers don't run endless queries (the page itself isn't refused), and
  states `Content-Signal: search=yes, ai-input=no, ai-train=no`. On the content origin
  it disallows everything, and is the one path served there besides images and
  originals. Protected responses also send
  `X-Robots-Tag: noindex, noarchive, noai, noimageai`. All of these are requests a
  crawler can ignore, and a crawler obeying `robots.txt` never fetches the header.
- **Throttles.** Per client IP: chapter reads, `/full` (lower, since one request is a
  whole work) and original downloads, each counted before any cache. Images aren't
  throttled, since one chapter can hold many. First values per 60 seconds are 120
  chapter pages, 10 `/full` and 10 originals, revisited with the others in Surge controls.
  Those let one address take 14,400 whole works a day, so they slow a scraper and don't
  stop one; a limit low enough to stop one would throttle readers sharing a mobile
  carrier's address. A limiter that throws doesn't fail the read. So that another site
  can't spend a reader's limits with `<img>` tags or frames, a request with
  `Sec-Fetch-Site: cross-site` and a `Sec-Fetch-Dest` other than `document` gets the 403
  on these paths, uncounted. It can't help a scraper, which gets no text that way. Images
  are exempt, since they aren't throttled.
- **What this doesn't stop.** A scraper posing as a browser across many addresses is
  slowed at most, and an agent driving a person's real browser looks like that person.
  Stopping those would take a sign-in to read, which the operator ruled out on
  2026-11-04 to keep the archive readable by everyone.

## Auth (magic link: Better Auth + Resend)

- **Library.** [Better Auth](https://www.better-auth.com/) 1.7 with its
  magic-link plugin, running inside the web Worker. It's open source and
  self-hosted: users and sessions live in Neon, and no third-party script
  reaches the browser, which only ever sees our own HTML forms. A spike against
  1.7.14 confirmed the behaviour below. Notes:
  - Workers needs `nodejs_compat`, because Better Auth uses `AsyncLocalStorage`.
  - Build the auth instance per request from `env` (Hyperdrive, secrets),
    because bindings only exist inside a request.
  - Pin `better-auth` and `@better-auth/kysely-adapter` to the same version.
- **Requesting a link.** `POST /login` is our own route: a plain form with
  Turnstile. Better Auth's own endpoint only accepts JSON, so our route calls
  `auth.api.signInMagicLink` on the server. Calls made that way skip Better
  Auth's CSRF check, its redirect check and its rate limiter, so our route does
  all three:
  - it checks `Origin` / `Sec-Fetch-Site`: a POST whose `Origin` is present
    and isn't exactly `https://rarepair.fans`, or whose `Sec-Fetch-Site` is
    present and isn't `same-origin`, gets 403. Same-site isn't enough, because
    every `*.rarepair.fans` host, `content.rarepair.fans` included, is
    same-site with the bare domain
  - it rate limits per IP and per email with the Workers rate-limiting binding
    (429 with `Retry-After`; a failed or missing Turnstile token gets 400 and
    the form again with an error, as in Surge controls; the per-email limit lets a
    stranger delay the form, and a failed request still uses up its limit, both
    also in Surge controls), then counts the address
    against its daily cap in Postgres (Surge controls, Sign-in emails per day)
  - it reduces `next` to a same-site path (root-relative only: no `//`, no
    `\`, no control characters) before passing it on. The `//` check runs
    again after URL normalization, because `/a/..//evil.example` normalizes
    to `//evil.example`.
  Tokens last 15 minutes and are stored hashed (`storeToken: "hashed"`) in
  Better Auth's `verification` table. An accepted request, and no refused one,
  also sets the sign-in marker: the cookie `__Host-signin-pending`, with a fixed
  value that holds nothing about the address, the token or the account,
  `HttpOnly; Secure; SameSite=Lax; Path=/` and no `Domain`, lasting as long as
  the newest link. It is the same whether or not the address has an account. It isn't
  a session, and it doesn't stop a signed-out reader's pages coming from the
  edge cache.
- **Using the link.** The email links to our `GET /login/confirm?token=…`,
  which shows a "Sign in" button: a POST form that uses nothing up. Mail
  scanners that open links in advance therefore can't burn it. For an unused,
  unexpired token the page also names the account, masked ("Sign in as
  j***@example.com": the first character, three stars and the domain, all
  lowercased), so someone sent a link for another person's account can see it
  isn't theirs. The address comes from the token's own row, read directly with one
  select: no write, no path through Better Auth's clean-up delete, and no read of
  `user`, so the page doesn't say whether an account exists. An unknown, used or
  expired token gets the same page with no address (a link with no token, or one
  far longer than any issued, is redirected to `/login` instead). Anyone holding the link sees
  the masked form, and each open, a scanner's included, costs one database read;
  the operator accepted both (#615, question 1 of #242). `POST /login/confirm` calls `auth.api.magicLinkVerify`, which redirects to
  `next` with the session cookie. A used, expired or unknown link is
  redirected to `/login` with a plain message. Every answer of the POST's route,
  a refusal or a fault included, clears the marker. Before launch sign-in is
  closed: both routes redirect, so none of this can be reached.
- **The browser that asked.** When `GET /login/confirm` sees the marker, the
  page also carries one nonced script that submits its form once as it loads,
  so the browser that asked for the link, while it holds the marker, signs in
  with nothing to press. It does this for whichever link is opened: an older,
  used link lands on the plain message, and the newest then takes a press. With
  JavaScript off, or a press in that instant, the form works as it always does
  (a second post gets the used-link answer). Without the marker the page has no
  script, so a mail scanner that runs scripts can't spend the token, someone
  opening a link planted by another person isn't signed in just by opening it,
  and asking on a laptop and opening the email on a phone takes one press. The
  marker says this browser asked for a link recently, not which one: someone who
  asked for their own and opens, or is navigated to, a planted one within 15
  minutes is signed in to the planter's account with no press, a limit the
  operator accepted (#606, #657).
- **Signed-out requests to signed-in pages.** Opening a page that needs an
  account (`/upload`, `/me/uploads`, `/works/:id/report`) while signed out, or
  POSTing a report, redirects to sign in, carrying the page as `next`, so the
  reader comes back to it after confirming the link. `/admin` is the
  exception: it answers 404 (Author requests & takedowns, Moderation).
- **Unknown email.** Signing in with an email that has no account creates one
  when the link is confirmed. This is Better Auth's default; we don't set
  `disableSignUp`. A brand-new account must accept the terms on a one-time page,
  `/welcome/terms`, before anything else: until it does, every page requested
  with its session redirects there, except that page itself, `/terms`,
  `/privacy`, `/about`, removal requests and copyright notices (`/remove`, `/dmca`:
  anyone can make them, and a typed notice must not be lost to a redirect), sign-in
  and signing out, `/admin` (its own gate answers a non-moderator 404) and static
  files. `TERMS_EXEMPT` in `apps/web/src/terms.ts` is the list. Accepting sets `user.terms_accepted_at` and
  continues to the stored `next`. Accounts that have accepted never see the
  page again.
- **Single use.** The token is consumed by one `DELETE … RETURNING` in
  Postgres, and only the request that gets the row back is signed in, so two
  simultaneous uses can't both succeed. This holds only while tokens live in
  the database. KV has no atomic get-and-delete, so if KV is ever added as
  Better Auth's `secondaryStorage`, set `verification.storeInDatabase: true`.
- **Session cookie.**
  `__Secure-better-auth.session_token; HttpOnly; Secure; SameSite=Lax; Path=/`,
  set with `useSecureCookies: true`. There is no `Domain`
  (`crossSubDomainCookies` stays off), so the cookie never reaches
  `content.rarepair.fans`.
- **A session lookup fault answers 500.** A signed-in request whose session
  lookup faults (Postgres or Hyperdrive down) gets a 500, even on a page that
  works signed out. A fault isn't read as signed-out: that would hide the
  outage and could sign people out without telling them. This holds for every
  route. A request with no cookie never looks anything up.
- **Sign-out is `/logout`.** `POST /logout` from a button in a form, behind the same
  same-origin check as the sign-in forms (before the session lookup), calls
  `auth.api.signOut`: it deletes the session row and clears Better Auth's cookies with
  the attributes they were set with, and the answer is a 303 to `/`. The response also
  carries `Clear-Site-Data: "cache"`, so a page the browser kept while signed in is fetched again, in a browser that
  honours the header (Chromium does, on a 303 too; Safari and Firefox are unchecked). Not `"cookies"`: the reader's settings live in
  cookies and outlast a sign-out. It ends only the session the cookie names: other devices stay signed in. With no session the answer is the same. `GET /logout`
  signs nobody out: it shows the button, or says the visitor isn't signed in. Better
  Auth clears the cookie even if deleting the row failed and `signOut` answers success
  either way, so the route reads the row of the session the cookie resolved to, by id, after `signOut` (through
  `HYPERDRIVE`; a read that a query cache could answer from before the delete would
  mislead it; `HYPERDRIVE` is uncached once deploy step 4 in *Connections* is done). If the row remains, the answer is a 500 "try again" page: no
  cookie change, no `Clear-Site-Data`, and nothing says the person is signed out. A
  database that can't be reached is a plain 500 the same way (#588).
  Open before launch and exempt from the terms gate.
- **Better Auth's own rate limiter** only covers requests through
  `auth.handler`. Its default memory store is per isolate on Workers, so set
  `rateLimit.storage: "database"` (or a Durable Object through
  `customStorage`), with `ipAddressHeaders: ["cf-connecting-ip"]`.
- **Email: Resend only.** The web Worker puts each email on an `email`
  queue. A dedicated **mailer Worker** (`apps/mailer`) consumes it and sends
  through a small sender interface. Volume isn't the risk; sending limits are.
  - **Why it's its own Worker:** sign-in mail must keep flowing during an
    upload surge, so it shares no deploy, concurrency limit or failure with
    `apps/ingest`. It also keeps the email-provider keys out of the web
    Worker. The mailer only sends: it has no database or R2 access.
  - **Reader privacy:** the mailer never logs email addresses or links; it
    logs provider message IDs and outcomes only.
  - **Failures:** a message Resend refuses is retried by the
    queue, then moved to a dead-letter queue, never dropped silently. Queued
    messages hold an address and a link (a sign-in link expires after 15
    minutes, a wait list or removal confirmation link after 7 days), so the dead-letter
    queue keeps them for one day at most, and
    nothing prints its contents to logs.
  - The mailer sends with Resend's batch API, to stay under its
    per-second API limit (by default about 2 requests a second; ask for more
    before launch).
  - Mail goes from a dedicated subdomain with SPF, DKIM and DMARC, warmed up
    before launch. The wait list's confirmation emails do that warm-up, and
    the launch email goes from the same subdomain (Wait list).
  - **Two queues.** `email` carries sign-in, wait list confirmation and removal
    confirmation emails (Author requests & takedowns).
    `email-bulk` carries only the launch email, and its consumer sends at a
    configured rate that leaves room under Resend's per-second limit, so a
    launch send never delays a sign-in link.
  - Resend is the only provider: there is no failover at launch (operator
    ruling, 2026-11-05). While Resend is down, sign-in stops until it returns.
  - Cloudflare Email Sending isn't used for launch: it's in beta, and new
    accounts start on a "conservative daily quota" that a signup surge would
    hit.
  - The login page tells people that links can take a minute to arrive during
    busy periods.
- Accounts are needed only to upload, report, save reading position or turn
  the warnings screen off. Reading never needs an account.

### Deleting an account

A request reaches the operator at admin@rarepair.fans, and the privacy page says
so. There is no self-service button and no form. The operator checks the request
came from the address, then runs `scripts/account-delete.mjs <address>` locally:

```
DATABASE_URL=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
POSITIONS_NAMESPACE_ID=... node scripts/account-delete.mjs <address>
```

Secrets come from the environment only. The token needs Workers KV Storage Write,
and `POSITIONS_NAMESPACE_ID` is the id of `apps/web`'s `POSITIONS` binding.

The script finds the account by address in any case, and shows what it will delete
and what will stay. It goes on only when the address is typed again. Then it
deletes, in this order:

1. The sessions, so a signed-in reader stops saving positions.
2. Its unspent sign-in links in `verification`, since one would make a new account
   at the address.
3. After a minute's wait, because KV lists can lag a write by up to a minute: the
   same again, since the person could sign in during the wait, then the
   `pos:<user id>:` keys, listed through the KV API and removed in bulk.
4. The same again, then the `user` row, which also takes its `account` rows.

A failure before the row goes leaves it, so running the script again finishes the
job, unless a ban has landed meanwhile. With the row gone first, the keys could no
longer be found from the address. A lost reply to the row's delete reads as a
failure, and the next run finds no account. Keys can still be left behind: a save
past its session check when the sessions go, or one made during the wait by someone
who signed in again, may not be in the list. Nothing can read such a key once the
account is gone, and it expires within a year.

What stays, and why:

- **Upload rows**, with `user_id` null, because `work_versions` points at them;
  works and versions stay public. A moderator's work page says "Deleted account"
  on that version's row, with no ban form. A confirmed upload not yet saved is
  refused as a banned uploader's is, because `isUploaderBanned` counts an account
  with no row as banned. An open upload can't be confirmed with no account, so the
  reaper takes its row and file (Orphaned uploads). A link already handed out can
  still store its file until the link expires, and the `uploads/` expiry removes it.
  A version held for review stays held, and a moderator can still approve it.
- **Reports**, with `reporter_id` as it was. It has no foreign key, so a deleted
  account's report still counts toward the automatic hide (Author requests &
  takedowns). No page shows a reporter's id. A blocked reporter's report is left
  out of that count by way of the account's email and sessions, so once the account
  is gone that report counts again. Someone who signs up again at the same address
  has a new id, so they count as a second reporter.
- **`takedowns.resolved_by` and `requester_blocks.created_by`**, with the id as it
  was and no foreign key: the record of who acted stays, as it does for
  `moderation_actions.moderator_id` (Moderation).
- **What a requester or a notice's sender sent.** It follows Decisions so far,
  Requester data, even when the address is the same.

The script refuses a banned account and says so. A ban is `banned_at` on the row,
so deleting the row would let the person sign up again with the same address. A
ban that lands while the prompt waits is seen before anything is touched. One that
lands during the minute's wait keeps the row, and the script says the sessions and
positions are already gone. The script prints the account's address and role, counts,
an HTTP status or a code, and no key, token or raw error.

## Author requests & takedowns

The archive shows people's work without asking them first, so these features
are part of the MVP, not extras.

**No claims while AO3 is down.** AO3 is the only place that could vouch for who
wrote a work, and it's offline. Rather than accept weak proof, we don't offer
work claims, author accounts or author self-service at all. Authors don't need
an account. Whoever asks, and confirms their email, gets the same thing: a work hidden or an opt-out
applied. Authors update a work the same way anyone does, by uploading a newer
epub, under the normal versioning rules.

- **Remove my work.** A public form at `/remove` asks for the work's URL here
  or its AO3 URL, a contact email and a short statement. No sign-in, but
  Turnstile is required. The request is stored unconfirmed and one email with
  a single-use link goes to the contact address; the work is hidden when the
  requester **confirms it from that link**, and a moderator reviews the
  request. We err on the side of the person asking. If the AO3 URL
  given isn't a work in the archive, nothing is stored and no email is sent:
  the page says the work isn't here and suggests opting out the pseud
  instead, which also covers future uploads.
- **Opt out.** The same form, given a pseud instead of a work. Once the
  requester confirms it from the emailed link, it hides every existing work by
  that pseud and becomes an active opt-out, which is checked again at ingest
  for new uploads; until then no opt-out row is active and ingest sees
  nothing. A moderator approves it. A mistaken opt-out can be reversed. It
  matches the one pseud given and never an AO3 user name, so the form tells
  authors to send one request per pseud. The form refuses `orphan_account` and
  `Anonymous` (compared as `pseud_norm`) when no work is given, since many
  authors share them, and points the requester to asking for a specific work.
- **The confirmation link.** It is a token of 32 random bytes, stored only as a
  hash and cleared when used. Opening it shows a button and changes nothing, so
  a mail scanner can't confirm; pressing it (a same-origin POST) is one
  transaction that locks the work first, claims the request and does the hide
  and the `request_works` rows. It works once and for 7 days from the email, and
  not for a request a moderator rejected. A used, expired or unknown link gets
  one page saying so. The submit page, the email and the confirmed page read the
  same whatever the work's status, and the email names neither the work nor
  the statement. If the email can't be queued the request is deleted and the page asks
  for a retry. There is no resend: asking again makes a new request with its own
  link, under the same rate limits. An unconfirmed request stays pending in the
  moderators' queue, marked unconfirmed (also in the related-requests table), and holds no
  hide, so it doesn't keep another request's hide from being lifted. Approve, for a removal
  request or an opt-out, is offered and works only for a confirmed request; an unconfirmed
  one can only be rejected, and a POST approve is refused with the item unchanged.
- **Abuse of instant hiding.** Nobody has to prove who they are, but a
  request hides nothing until its contact address is confirmed, so someone
  can't hide a work by typing another person's address. Anyone with an inbox
  can still hide any work for a while. Limits: requests are rate-limited per email
  and per IP (429 with `Retry-After`). A hidden work says why it is hidden,
  not a 404 (see below). Moderators can see every request from the same email
  or IP together, restore in bulk, and block a requester. We accept this risk:
  an unfair hide is temporary, while ignoring a genuine author is not.
- **The IP hash.** `ip_hash` is the hex HMAC-SHA-256, keyed with the `IP_HASH_KEY`
  secret, of the requester's network address: an IPv4 address whole, an IPv6 one by
  its /64, an IPv4 address written as IPv6 as that IPv4 address. A request with no
  address stores the hash of a fixed `unknown` marker. The raw address is never
  stored or logged. Every form that stores or matches one uses `src/ip-hash.ts`, so
  blocks match what was stored; changing the key or the grouping orphans stored
  hashes.
- **Retention.** The hash is kept with the request, or with a requester block, until the site closes, then deleted
  by hand. It is not erased on request (operator ruling, 2026-11-04).
- **Block and ban stop only the action.** Blocking a requester (by contact
  email and IP hash) means their later `/remove` requests, and reports from an
  account with that email or IP hash, are still recorded and queued but no
  longer hide anything (an opt-out from them isn't applied until a moderator
  approves it). A block is checked when the requester confirms, not when
  they submit. A report's account matches an IP hash through the addresses of
  its sessions, hashed at each report; sessions expire, so an account with
  none left matches by email only. Every requester sees the same confirmation (FRONTEND-DISCOVERY,
  journey 4), and the page never reveals that a requester is blocked. Banning
  an uploader (an account, `banned_at`) stops it uploading and reporting, and
  stops its in-flight uploads: its `pending` uploads end `account_banned`, and
  so does a job ingest has not yet saved, at its next ban check (before the
  file is read, or in the save's transaction), unless the job was refused
  for another reason first. Its live works and finished uploads stay
  until a moderator acts on them. A moderator bans from a work's admin page
  (`POST /admin/users/:id/ban`); nobody bans themselves, a moderator or an
  admin, and there is no unban at launch. The upload and report routes read
  the ban from the database on every request, so a session signed in before it
  is refused after it.
- **What hidden, held and removed works show.**
  - **Hidden** (`hidden`, by a removal request or opt-out, by reports, or by a
    moderator): 451 on the work page, every chapter URL and `/full`, with one
    line that names the cause (`works.hidden_cause`): "Temporarily hidden after
    a removal request", "Temporarily hidden after reader reports" or
    "Temporarily hidden by a moderator". Nothing else about the work is shown,
    and it is left out of search, listings and the home page. A chapter page
    cached before the hide can stay readable (not the 451) for up to 60 s after
    it was cached, in each data centre, which can run slightly past 60 s from the
    hide. The work page, `/full`, tag listings, search and the home page read
    through the cached connection (see *Connections*), so they can show the work
    for up to about 75 s after a hide (a tag listing adds its browser cache, see
    Reading), and a chapter's own read adds the same to its 60 s. A hide does not purge it, unlike removal (see *Removal really removes*
    below). This applies to every hide cause. A hidden work's images and original
    on the content host are different: a request that misses the content Worker's
    cache gets 451 (see Hosts), and the data centres' cached copies age out within
    12 hours of being stored, so a hidden work's images can stay visible for up to
    12 hours after the hide, in each data centre that cached them. A browser keeps
    an image or original it already has for an hour, and a cache hit gives it a fresh hour,
    so a browser can show it up to 13 hours after the hide (see *Edge cache*); nothing here purges it. A restore needs no action: the next
    miss reads `live` and fills the cache again. A declared automated client gets
    a 403 on the chapter URLs and `/full` instead (Crawlers and agents).
  - **Held** (a `held_for_review` version, never public): 404 to the public.
    The work keeps serving its current version. The held version is visible
    to its uploader in My uploads and to moderators.
  - **Removed** (`removed`): 410 on the work page, every chapter URL and `/full`,
    "This work has been removed". A declared automated client gets a 403 on the
    chapter URLs and `/full` instead (Crawlers and agents).
  - **The report routes** (`GET` and `POST /works/:id/report`) answer 404 for a
    hidden or removed work, as for one that doesn't exist: only the work,
    chapter and full pages show 451 or 410.
- **Removal really removes.** Setting a work to `removed`, through a takedown,
  an author request or a moderator, also deletes `works/<ao3_work_id>/` and the raw
  upload from R2, and purges the work's pages, cached fragments, images and
  download URLs from the cache. Public pages that read the work through the cached
  Hyperdrive connection can still show it, and can store a chapter page after the
  purge, for up to about 75 s (see *Connections*). Images and downloads stay in a data
  centre's cache for 12 hours, so without the purge parts of a removed work stay reachable. That
  the purge clears the content Worker's own cache entries is not yet confirmed (see
  Surge controls, Edge cache); if it does not, a removed work's cached images and
  downloads age out within 12 hours, and a request after that gets a 404. The sweep finishes what the purge or an ingest clean-up
  missed: each run, within its limits (works and R2 calls a run, and one pass over the
  bucket a day), deletes everything under the folder of a work whose status is
  `removed`, with no age limit, along with `originals/<upload_id>.epub` for each
  `<upload_id>/` prefix in that folder. The status is read fresh: the query selects
  `now()`, a non-immutable (stable) function, so Hyperdrive never serves it from its cache, and the
  Hyperdrive config has caching off too; a change to that read must keep it uncacheable.
  The sweep skips a work that has an upload pending or processing whose `<upload_id>/`
  prefix is in the folder, or that is already tied to the work, and takes the work on a
  later run; an upload stuck in either state keeps its work skipped until it ends. A job
  that hasn't written yet can't be seen, but it can't commit a version of a removed
  work either: the status checks of step 8 refuse the commit, and the job deletes its own
  files. A folder the run leaves partly deleted is visited again, and an emptied folder no
  longer appears in R2, so later runs don't visit it. This relies on
  removal being permanent: nothing restores a `removed` work, and a restore would have to
  change this rule first, as the sweep would delete a restored work's files on a stale
  read (step 8's branch for a work restored meanwhile is defensive, for that reason).
  A folder with no `works` row is not a removed work and gets the ordinary rules. Not
  covered: an original whose `<upload_id>/` prefix is gone while the upload has no
  `work_id` (nothing ties it to the work).

  To find who uses an image, the sweep reads every fragment of every version of
  any work with an image older than 24 hours, on every lap. Ten versions of 80
  chapters is 800 reads, and a run's budget is 8,000 subrequests, so big works
  can spend it. A work that runs out is skipped with the reason `budget`, so the
  sweep fails closed and deletes nothing it couldn't check. Recording each
  version's image keys in Postgres when it is saved waits until a sweep report
  shows `budget` skips.
- **The removal list.** `/removed` lists removed works, newest first: title,
  byline, "The original work" link with its ID and its note, as on the work page,
  date and reason. `/removed/pseuds` lists pseuds with an approved, active opt-out,
  in `requests.pseud_typed`'s cleaned form. Only a `removed` work is listed, so
  a work hidden by an opt-out or anything else is not, and no pending or unconfirmed
  item is listed or counted. An unfair hide stays temporary and private. Nobody's
  identity is checked, so the wording names the route ("Removed after a removal
  request"), never the person, and the pages say so. The reason is set when the
  status changes, by `removeWork` under its lock, so a repeat remove needs none and
  keeps the first. The approved item decides it: a takedown gives `dmca` and a removal
  request gives `removal_request`. A moderator's own remove gives `dmca` when a notice
  on the work is pending, and otherwise must choose `wrong_file` or `site_safety`, or
  `removal_request` when a confirmed pending request or an active opt-out covers the
  work. The migration derives a reason for works already removed, the same way, with
  `site_safety` when nothing else applies. An opt-out from before it, approved or
  pending, keeps a NULL `pseud_typed` and is never listed, since its requester was never
  told. For the same reason a work it gives a reason to starts withheld. A pending
  `remove_work` request from before it is not marked: the site hasn't launched, so these
  rows are test data. Approving an opt-out that has a
  `pseud_typed` adds its pseud to `listed_pseuds`, or, when a row is there whose request
  isn't approved, points the row at this one; a withhold chosen at that step applies,
  and approving never lifts one. Rejecting one moves the row to the earliest remaining
  approved opt-out with a `pseud_typed`, or deletes the row when none remains.
  A withheld row with none remaining stays, so a later approve can't republish the name,
  and un-withholding it deletes it. Each takes a transaction advisory lock on the
  `pseud_norm` after its request row, so a concurrent approve and reject can't leave the
  row wrong. Statements, DMCA fields, requesters and moderation notes are never shown.
  A reversed opt-out takes the entry off, and the action log keeps the history. A
  removed work can't be restored (`restoreWork` leaves it as it is), so its entry
  stays. A moderator can withhold an entry, for a title or name that shouldn't be
  republished or a removal made by mistake: a work then shows only the date and reason,
  and a pseud is left out, and shows as "Name withheld" in any listed byline. Every
  confirm step that removes a work or approves an opt-out with a `pseud_typed` shows the
  entry and offers the withhold before anything is published. It is already selected for `site_safety` and
  for a pseud with no works here, whose typed text nothing in the archive backs. A byline
  comes from the uploaded file, so the pages say the people named may have done nothing.
  Each withhold and un-withhold logs `withhold` or `unwithhold`,
  on the work, or on target kind `pseud` with the `pseud_norm` as `target_id`. `/remove`
  and `/dmca` say what will be published before anyone submits. The pages carry
  `X-Robots-Tag: noindex` and give the moderators' contact address. Requests
  `pageCacheable` allows share one edge cache entry per page number for up to 60 s,
  holding the page's data and not its nonce, on top of up to about 75 s in the cached
  Hyperdrive connection if these pages read through it (see *Connections*), so in each
  data centre a change can take about 135 s to show. Withholding
  purges nothing.
- **DMCA.** To get safe-harbor protection under US law (17 U.S.C. §512), we need
  a designated agent registered with the US Copyright Office, a public takedown
  form, a counter-notice process and a repeat-infringer policy. A notice from `/dmca` lands in the takedowns
  queue and does **not** hide the work by itself: a
  moderator decides whether to hide or remove it. While no moderator has acted
  on it, the notice doesn't block re-uploads of the work either. Once a
  moderator removes the work, by Approve or by Remove on the work or the notice's page, every
  pending notice on it is marked `removed` and its AO3 work ID goes on the takedown list, and
  later uploads of it are rejected `opted_out` (EPUB processor, step 4). A
  notice missing statutory elements is still queued, marked incomplete (the Approve confirm page says so; approving is still allowed). The
  form has a Turnstile check, so it needs JavaScript; without it the page names an
  email address (the `NOTICES_EMAIL` var) for a notice, which a person reads and which
  doesn't reach the takedowns queue. A rate limit per IP, counted before the
  check, is its other abuse control; a refused post gives the form back with what
  was typed.
- **Reports.** Every work has a report button. Reporting needs a signed-in
  account, so each report has a reporter who can be rate limited or blocked;
  signed-out readers, opening the form or POSTing a report, are redirected to
  sign in, carrying `next`, and brought back to the form. A work with open
  reports from **3 distinct signed-in accounts** is hidden automatically, when the report that makes
  the third comes in, until a moderator restores it; several reports from one account count once.
  Reports from banned accounts can't be made, and reports matching a blocked
  requester don't count, nor does a closed report, a dismissed one included (an account with another
  open report on the work still counts). One reason is "This version is wrong"
  (`wrong_version`), which only queues the work in *Works to check*: those
  reports never count toward the 3-account auto-hide. (Authors asking for
  removal use `/remove`, which needs no account.)
- **Moderation.** A small admin area has four queues, each a table, oldest
  first:
  - reports
  - takedowns (DMCA notices)
  - removal or opt-out requests
  - *Works to check*: works with a held version, works live with the "may be
    imperfect" notice, and works reported as "This version is wrong"

  Actions are hide, remove, restore, approve, reject, dismiss a report, block a requester, ban
  an uploader and withhold a removal list entry. Block a requester is on removal
  and opt-out request pages only: a takedown's requester is free text, so
  takedown pages don't offer it. "Dismiss report", on an open report's page,
  sets it `closed` and logs `dismiss` on the report. It hides and restores nothing, so a work the
  reports hid stays hidden until Restore lifts the hide. A `wrong_version` report keeps its own form. A *Works to check* item's page has approve (clears the notice,
  or publishes the held version), make a version current, hide and remove;
  each work's admin page lists every version with "Make current" and "Approve". Approving a held version
  makes it current and checked; each approve is logged once, on the version. Make current and
  approving a held version close the work's open "This version is wrong" reports, and a
  "Close wrong-version reports" form closes them without moving the pointer (logged as a `reject` on
  the work). Every
  moderation action a moderator or admin takes writes one `moderation_actions`
  row with their user id. For the database changes an action makes, the row
  is written in the same transaction: no row for an action that changed
  nothing or failed, and no row without its action. (An action's effects
  outside the database, such as removing a work's files, can't join that
  transaction.) A reject that also lifts a hide logs only the reject. A hide
  no moderator chose (the reports' automatic hide, a removal request's hide)
  writes none. Hide, restore, remove, approve and make current (logged on the version, and only when
  something changed, and for make current only when the pointer moved), ban, dismiss, the wrong-version close and the request and takedown rejects write a row
  today, and so does approving a removal request or a takedown. That approve asks to
  confirm, runs the removal (a `remove` row on the work, when its status changed), then marks
  the item and logs `approve` on it: a request becomes `approved`, a takedown `removed`
  (which puts its AO3 work ID on the takedown list). Only a `pending` item can be approved,
  and another pending request for the work stays pending. A failed cache purge still marks
  the item, and Remove on the work retries it. Approving an opt-out only confirms it: it is marked
  `approved` and logged `approve`, its `optouts` row stays active and its works stay hidden, and
  nothing is removed. Its confirm step shows the pseud as the removal list will show it, with a
  choice to withhold it. Rejecting an opt-out, pending or `approved`,
  reverses it: the request becomes `rejected` and its row goes inactive, so new uploads by
  the pseud are accepted again. A request's page lists the other requests from the same contact
  email (any case) or IP hash, and "Restore related works" restores in bulk: it rejects the
  pending `remove_work` requests among that page's request and its relatives, then restores
  their works, in one transaction. Rejecting a removal request, reversing an opt-out and a bulk
  restore bring back only works the request's own `request_works` rows name, still hidden for a
  removal request, and not one that another pending removal request or another active opt-out
  naming one of its authors still covers. Each logs one `reject` per request, with the restored
  works' AO3 work IDs in its note (led by "Opt-out reversed." or "Bulk restore from <request id>.") and no row per work (a request already decided gets a `restore`
  row per work instead). These leave the works' reports open: deciding a request doesn't read them, so they stay in their
  queues, and those that counted toward the automatic hide go on counting, at the next report. A
  replacing upload leaves `wrong_version` reports open too. The explicit Restore of a work is a
  moderator's deliberate act: it checks none of this, and when it lifts a hide it closes the work's
  open reports of every kind (on a work that isn't hidden it changes nothing). Each later action calls the same helper, `logModerationAction`, when
  it is built. The row's `moderator_id` has no foreign key to `user`, so
  deleting an account keeps its log rows, with the id as it was. Anyone
  without the moderator or admin role, signed out included, gets 404 for every
  `/admin` URL, so the admin area isn't advertised to anyone else. A moderator's
  or admin's site header has an Admin link, from the role that comes with the
  session (a display aid only: the gate above reads the role again on every
  `/admin` request and stays the authority). A promotion or demotion shows in the
  header, and takes effect at the gate, on the next request: the session lookup and
  the gate's own read both go through the uncached `HYPERDRIVE` binding (see
  *Connections*), once deploy step 4 there is done. Before that step, with Hyperdrive's
  query cache in front, a demoted moderator can still open `/admin` for up to about 75 s
  (the window in *Connections*).

## Wait list

The site goes up before the archive opens. While the web Worker's `PRELAUNCH`
setting is on, `/` is a coming-soon page with a wait list form, and every
other app page redirects there, except `/terms`, `/privacy`, the `/waitlist`
pages, `/welcome/terms`, sign-out and `/admin`. Sign-in is closed too, and its
links show disabled, so nobody gets a session until the archive opens. The last
three stay open for a session from before sign-in closed. That leaves no way to
become an admin before launch, and nothing needs one: the forms that fill the
queues are closed, and the launch send and purge are local scripts. Right after
launch, the operator signs in and sets their role. Turning `PRELAUNCH` off opens
the archive: `/` becomes the home page and `POST /waitlist` answers 404.

The wait list's pages are the only ones with web fonts: Fraunces and IBM Plex
Mono, the publishers' own woff2 files, unmodified (FRONTEND-DISCOVERY,
*Decisions so far*). The web Worker serves them as static assets at
content-hashed paths with `Cache-Control: public, max-age=31536000,
immutable`, so a visitor fetches them once and the edge serves them after
that. `default-src 'self'` already covers them, so the CSP gains only the
Turnstile frame. The coming-soon design canvas sets the look, not the
markup: its inline `style` attributes become stylesheet rules, because
`style-src 'self'` refuses inline styles.

- **Joining.** `POST /waitlist` is a plain form with Turnstile, with the same
  `Origin` / `Sec-Fetch-Site` check as `POST /login` (403) and rate limits
  per IP and per email (429). It stores the address and queues one
  confirmation email on `email`. The reply is the same "Check your email to
  confirm" page whether or not the address was already there, so the form
  can't be used to find out who is on the list. An unconfirmed address gets
  at most one new confirmation email an hour and 3 in all, so the form can't
  be used to keep mailing someone else. An address is accepted only if the
  mailer's message contract would accept it. The per-email limit is the one in
  *Surge controls* (anyone can keep an address at 429 for up to a minute).
  Every answer after the `PRELAUNCH` check waits at least `WAITLIST_FLOOR_MS`
  (2000 ms), 400, 403, 413, 429 and 503 included, so the time taken can't show
  whether an address is on the list. The floor must exceed the slowest path
  (insert or update, queue send, over Hyperdrive to Neon), and 2000 is a first
  value to check against measured timing before launch. The early refusals (403,
  413, 429) are padded too, so each holds a request open for the floor during a
  flood. We accept that.
- **Double opt-in.** `GET /waitlist/confirm` only shows a "Confirm" button,
  because mail scanners open links; `POST /waitlist/confirm` sets
  `confirmed_at`. Tokens are stored hashed and last 7 days. Double opt-in
  keeps other people's and mistyped addresses off the list, so the launch
  email's bounce and complaint rates stay low. That matters because it shares
  the sign-in mail's sending reputation.
- **The launch send.** The operator runs `scripts/launch-send.mjs` locally,
  once. It takes its secrets from the environment only (`DATABASE_URL`,
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` with Queues Write, and
  `EMAIL_BULK_QUEUE_ID`), and prints counts, an HTTP status or a Cloudflare
  error code, never an address. Each batch is one transaction: it claims up
  to 100 confirmed rows with `notified_at` empty in one statement that sets
  `notified_at` and each row's `unsubscribe_token_hash` (`for update skip
  locked`), puts the batch on `email-bulk` through the Queues HTTP API, and
  commits only once the push has succeeded. So no address is claimed twice,
  whether the script is rerun or two copies run at once, and a failed push, a
  timeout, a stop signal (SIGINT, SIGTERM, SIGHUP) or a hard kill leaves the
  batch's `notified_at` empty again, because the database rolls the claim
  back. A failed push stops the run with a non-zero exit, and the operator
  reruns it. The script prints how many confirmed addresses are still
  waiting after each batch and at the end, and exits 0 only when none is.
  Delivery is at least once, never lost: when Cloudflare accepted a push but
  the script can't know it (a timeout, an abort, an error status or an
  unreadable reply after the enqueue, a kill between the push and the commit,
  or a failed commit), the claim is rolled back and the next run queues those
  up to 100 addresses again, so they get two launch emails and only the
  second one's unsubscribe link works. The claimed rows stay locked while
  the push runs, up to its 30 second limit, so a one-click unsubscribe for
  one of them waits that long. If the machine sleeps or the network drops
  mid-batch, the database may hold the open transaction until it notices
  the dead connection; a rerun in that time skips those rows, reports them
  as still waiting and exits non-zero, and is run again once they free.
  The mailer sends at the configured rate, so the emails, and the visits
  they bring, arrive over hours. A launch email that Resend refuses
  is dead-lettered to `email-bulk-dlq`, which the web Worker consumes: it
  clears that address's `notified_at`, so a rerun of the script queues it
  again (rerun it after the queue has drained, and again after a day). The
  new claim stores a new token hash over the old one, since only the hash is
  kept and a raw token can't be recovered from it: that is safe here because
  a dead-lettered email was never sent. An
  `email-bulk` message is a JSON object `{ "kind": "waitlist-launch", "to":
  <address as stored in waitlist.email>, "url":
  "https://rarepair.fans/waitlist/unsubscribe?token=<base64url token>" }`.
  The queue's HTTP API must be given `content_type: "json"`, or the body
  arrives as a string and the mailer drops it. The token is the raw one: only
  its SHA-256 hash (lowercase hex, as `hashToken`) is in
  `unsubscribe_token_hash`. Each queue accepts only its own kinds, so a launch
  email sent on `email` is refused rather than sent unpaced. The mailer waits
  `BULK_INTERVAL_SECONDS` (`vars`, default 10, at most 300) after each batch
  of at most 50: at most 5 emails a second as configured. Check that figure
  against Resend's current limit before launch, and set `email-bulk`'s
  retention (default 4 days) longer than the whole send: the list size over
  50, times the interval.
  The mailer has no database binding, so the web Worker's dead-letter
  consumer reads only `to`. Each
  launch email has `List-Unsubscribe` with one-click
  `List-Unsubscribe-Post`. A POST to its link deletes the row, with no
  `Origin` check because mail providers send it, and with no rate limit: any
  well-formed 43-character token opens a Hyperdrive connection and runs a
  DELETE. We accept that. Opening the link in a
  browser shows an "Unsubscribe" button.
- **Deleting the list.** Once every confirmed address has been queued, and a
  day has passed since the last batch so any dead-lettered email has come
  back, the operator runs `scripts/waitlist-purge.mjs` locally, with
  `DATABASE_URL` from the environment only (no `.env`, no flag), after
  `PRELAUNCH` is off: the script can't see the Worker's setting, and while the
  form is live new rows keep arriving. There is no admin-area action and no
  Worker route for it. One transaction takes a table lock, so a launch send's
  open claim can't change the table between the check and the delete, then
  checks and deletes every row, confirmed or not. It refuses, deleting nothing
  and exiting 1, while any confirmed address has `notified_at` empty, or while
  the newest `notified_at` is under 24 hours old by the database's clock. A list
  with no confirmed address has nothing to send and is purged. `--force` skips
  both refusals and nothing else, and the script says it was forced. It exits 0
  when purged, 1 when it refused or the database failed, and 2 for a missing
  variable or an unknown flag. It prints counts and error codes only: no
  address, link or raw error. The page promises one email and nothing else, so
  nothing is kept for later. After the purge an unsubscribe link still answers
  200, and a confirmation link says the archive is open.
- **Privacy.** Only the address, the token hashes, the send times and how many
  confirmation emails were sent are stored: no IP
  address, user agent or referrer. Like every email the mailer sends, no log
  line holds an address or a link. The privacy notice describes the wait list.

## Surge controls

- Turnstile on signup, login, upload, the wait list, `/remove` requests and DMCA notices. Turnstile needs
  JavaScript, so those forms do too; reading, browsing and search work without
  it. Each form's widget names its own action (`login`, `waitlist`, `upload`,
  `remove` and `dmca`) with `data-action`, and the Worker passes
  a token only when siteverify reports that action and this host, so a token
  solved on one form is refused by every other. Cloudflare's published test
  secret keys, which don't promise an action, skip the action comparison only.
- The Workers rate-limiting binding covers abuse throttling on login, the
  wait list, removal requests, DMCA notices, upload requests and search, keyed
  per IP and per user (per email for login, the wait list and removal
  requests), and on chapter, `/full` and original reads, keyed per IP (Crawlers
  and agents). It's approximate and counts per Cloudflare location, over 10- or
  60-second windows. That's fine for slowing abuse, but not for hard limits.
  - **A stranger can delay a form.** The per-email limit counts everyone's
    requests for an address, so anyone with a solved Turnstile can keep an
    address at 429 for up to a minute, and the 429 tells the person that
    someone asked for it recently. This holds for the per-email forms: login,
    the wait list and `/remove` (`/dmca` is per IP only). We accept that.
  - **A failed request still spends its limit.** The binding counts when it
    checks and can't give a count back, so a request that fails after the check
    (a database 500, a queue error, an unknown work, a Better Auth 400) still
    uses up the address's limit, and after an outage a person can see a 429 for
    up to a minute. We accept that.
- **Status codes.** A rate limit or quota that is hit returns **429** with
  `Retry-After` and a plain page saying when to try again (`POST /uploads`, which a
  script calls, answers JSON `{ error, retryAfter }` instead). A failed or missing
  Turnstile token returns **400** and shows the form again with an error (as does
  a 503 when Turnstile can't be reached and a 413 for a body too large; the form
  may hold what was typed, so each is sent `Cache-Control: no-store`), and
  so does a form missing required fields (such as `/remove` without a contact
  email, or without a work or pseud). `POST /remove` answers 503 too when its
  confirmation email can't be queued, and a used, expired or unknown removal
  confirmation link (`/remove/confirm`) gets a **400** page. A sign-in POST from any other origin (a
  bad `Origin` / `Sec-Fetch-Site`, as in Auth) gets **403**. An upload request
  declaring more than 25 MB for any file, or asking for more than 10 files, gets **413**. A used, expired or unknown magic link is
  **redirected to `/login`** with a plain message. A signed-out request to a
  signed-in page, or a signed-out report POST, is **redirected to sign in**,
  carrying `next` (Auth); a signed-out request a script makes, such as
  `POST /uploads`, gets **401** instead, since a script can't follow that
  redirect. A non-moderator on `/admin`, signed out included,
  gets **404** (Author requests & takedowns, Moderation).
- Upload quotas are hard limits, so they're counted in Postgres (or a Durable
  Object). There are two daily tiers: new accounts get a lower limit, trusted
  users a higher one. The numbers and the rule for "trusted" are configuration,
  set before launch from load testing.
- **Sign-in emails per day.** One address gets at most `LOGIN_EMAIL_QUOTA` (5)
  sign-in emails a UTC day, however many solved Turnstile challenges someone brings
  (operator ruling, 2026-11-05). It's counted in Postgres, in `sign_in_email_counts`,
  by one statement, so the count holds across isolates and two requests can't both
  take the last one. `POST /login` counts after Turnstile and the per-minute limits,
  so a flood those catch costs no database write, and before the send: a send that
  then fails isn't given back. Past the limit it's the 429 page, saying to try again
  after midnight UTC, with `Retry-After` counting to then, and nothing is sent. If the
  count fails the request goes through, like the other limits: sending the link needs
  the same database.
  - The address is held only as the hex HMAC-SHA-256, keyed with the `IP_HASH_KEY`
    secret, of a prefix and the address trimmed and lowercased (`src/ip-hash.ts`).
    `+tag` and dot spellings are not merged (operator ruling, 2026-11-05). Changing
    the key only starts the day's counts again.
  - The statement that counts also deletes every address's rows from earlier days,
    so a day's rows last until a later day's first counted request. This one table's rows
    are all it deletes: it's no retention job for other data.
  - **Known limit.** A stranger who solves Turnstile 5 times can use up someone's
    sign-ins for the rest of the day, and a real person who loses their links can hit
    the cap. That person waits until the next day.
- **Orphaned uploads.** Each presigned PUT signs the size declared for its file as
  `Content-Length`, but nothing shows that this stops a PUT of another size:
  Cloudflare's docs say a signed `Content-Type` is enforced and, as far as two searches
  on 2026-11-05 found, don't say whether a signed `Content-Length` is. The live check on
  real R2 is on the operator's list for after deploy. So a file that reaches `/complete` is checked
  either way: it deletes an object over 25 MB or of any other size than was declared, unless a
  confirm has already counted the upload, when the object is ingest's. A client may also never
  call `/complete`, so three more limits apply. An account's open uploads (`pending` and not
  counted by a confirm) can't pass its daily quota for its tier: asking past that cap gets 429
  with a `Retry-After` of an hour, the row lock in `insertUploadsWithinCap` holding it under
  parallel asks. The daily sweep's reaper deletes open uploads older than `UNCONFIRMED_UPLOAD_DAYS`
  (`apps/sweep`, 1 day, 7 at most), the row first and then the objects of the rows actually
  deleted, so they leave My uploads; with a daily run, a row lives one to two days. A run reaps
  at most 500,000 rows, and the next takes the rest. A confirmed upload is never reaped, whatever
  its age. And an R2 lifecycle rule expires anything under `uploads/` after 7 days, which also
  takes an object whose delete failed.
  **What an account can store depends on the live check.** Nothing checks the size of an object
  nobody confirms. If R2 enforces the signed size, an account holds at most its cap times 25 MB
  through unfinished links: 500 MB on the new-account quota of 20, 2.5 GB on the trusted 100. If R2
  doesn't, each link can hold what one PUT can (5 GiB by R2's limit, as far as its docs say), so
  about 100 GiB per new account for the day or two until the reaper runs. Those are the bounds on
  unfinished links, not on an account. A link still works for its 10 minutes after confirm, so a
  file can be replaced behind a counted upload, where neither the cap nor the reaper sees it
  until the 7-day rule: a day's quota of 20 for 8 days holds about 4 GB if R2 enforces the size,
  about 800 GiB if it doesn't. A link whose upload has ended has no per-account bound at all,
  only the rate limits and Turnstile (the open bugs #635 and #637). Since the cap is the daily quota, raising
  `UPLOAD_QUOTA_NEW` raises these bounds with it, and a quota under 10 can't take a full batch of 10.
  Raw files the archive keeps are copied to `originals/` during ingest.
- Queue backpressure: set a maximum consumer concurrency so Neon connections
  stay bounded. Hyperdrive pools connections, and Neon autoscales compute. Each Hyperdrive
  config keeps its own pool, and the web Worker uses two: before launch, check the pool
  sizes of the two configs and the ingest and sweep one against Neon's connection limit.
- Edge cache: images and original downloads on `content.rarepair.fans` can go away
  (a hide, a removal, an opt-out), so neither lifetime is long and neither is `immutable`.
  A data centre keeps an entry for 12 hours, because a hide does not purge, and a browser
  keeps a file for an hour. The entry is stored under `Cache-Control: public, max-age=43200`
  and every response a browser gets, hit or miss, carries `public, max-age=3600`: the
  Worker rewrites the header on a hit, so the edge's lifetime never reaches a browser. The
  entry's lifetime is its `max-age`, not an `s-maxage`, so nothing depends on the Cache API
  reading `s-maxage` (the local runtime expires an entry on `max-age` alone; the live zone
  is not measured, and an operator checks it before launch (step 7 of the list in *Connections*), by seeing a cached file refilled
  after 12 hours, and by fetching a cached file twice and reading its `Cache-Control` and `Age`
  on the second response, with the zone's Browser Cache TTL and any Cache Rule or Edge Cache TTL on the content host not overriding the header). A hit
  hands a browser a fresh hour whatever the entry's age, so a file hidden just before its entry
  would expire can sit in a browser for up to 13 hours (12 at the edge, then the last hour a
  hit gave out). Each value is named once, in the content Worker's `index.ts`.
  Without `immutable` a browser's reload fetches the file again instead of reusing its copy.
  The response has no validator, so that is a full download, served from the edge entry (the
  Worker keys the cache by URL alone, so a reload's headers pick no other entry): it costs
  bandwidth, not a database or R2 read. A plain visit within the hour costs neither. The content Worker also
  stores each 200 in the Workers Cache API (`caches.default`) under the bare request
  URL, in the data centre that served it (no replication, no tiered cache), so a
  repeat request there skips R2 (each data centre misses once per key, and
  concurrent first requests are not coalesced). It never caches `HEAD`, error responses or
  `Range` and conditional requests, and it adds no negative cache. Removal's purge
  by URL (both `originals/` forms) and by prefix (a work's `img/` prefix) is meant
  to clear these entries, and each key is exactly the URL that purge names, but
  Cloudflare's documentation does not confirm that a purge by URL or prefix reaches
  Cache API entries in every data centre: this is unverified on the live zone
  (the prefix purge for images included), and an operator checks it before
  launch (step 7 of the list in *Connections*). If it fails, a removed work's images and downloads stay cached for up
  to 12 hours. A request that read R2 (and a work's status) before the removal's delete
  or a hide can also store its response after a purge, and that entry too ends within
  12 hours of its store. Browser caches are untouched. The site
  stops serving a hidden or removed work's files once the edge entry is gone: 12 hours from
  its store after a hide, and at the purge for a removal if the purge reaches the entry
  (otherwise 12 hours from its store). It cannot reach an epub a reader has saved, or a
  browser's copy, which lasts an hour from the browser's last fetch, so up to 13 hours
  after a hide. Entries stored before this ticket shipped carry the old headers; an operator
  purges the content host's whole cache at deploy, which clears them if the purge reaches Cache API entries (unverified, as above); otherwise they end within 12 hours of their store. Chapter fragments are
  cached inside the web Worker (see Reading). Work and tag listings
  get a short cache with stale-while-revalidate.
- Observability: Workers Logs and traces are on from day one, except that the
  web and content Workers' per-request invocation logs are off (their URLs carry
  the AO3 work id, and the web Worker's the chapter too); their errors and metrics
  stay on, and the content Worker's traces are off too (turned on only for a live
  fault). Track queue depth, ingest failure
  rate and search p95 on a dashboard, with crawler refusals by reason and throttled
  reads, each counted from a log line holding only the reason.

## Connections

The web Worker reaches Neon through two Hyperdrive configs. Hyperdrive caches reads by
default, and a cached read can be old: `HYPERDRIVE` is the one with caching off, and
`HYPERDRIVE_CACHED` has it on.

- **`HYPERDRIVE` (caching off) is the default.** Sessions, roles and every `/admin` page,
  sign-in and its link check, terms, uploads and their status, reports, removal and DMCA
  requests and their confirmation, the wait list, and the launch dead-letter consumer. A
  sign-out, a demotion, a ban or a used token takes effect at once, and a read that
  decides a write sees the row it is about to write over. Ingest and the sweep have this
  one alone, because their reads feed writes (the lease, the opt-out and removal checks,
  versioning, what to sweep); a read added there that is only a check stays on it too.
  So does the content Worker, which has no other: its status read decides what a miss
  may serve, so a hide must reach the next miss, not wait out a cached read.
- **`HYPERDRIVE_CACHED` (caching on) serves public pages only,** and only these: the home
  page, tag listings, search, the work page, the chapter reader, `/full` and the
  warnings screen. They only read. `/removed` and `/removed/pseuds` are not built: the ticket that builds them names their
  connection, and the allowlist and its test change with it. A node test
  (`hyperdrive-connections.node.test.ts`)
  fails if any other file names the binding (it reads source text: a helper handed `env`
  would get past it, and the workerd test in `24-hyperdrive-connections.test.ts` covers the
  paths it names).
- **The window.** Hyperdrive's docs give a default `max_age` of 60 s and
  `stale_while_revalidate` of 15 s, with no invalidation on write: up to about 75 s.
  These figures are from the docs; they can't be measured locally, since a local
  Hyperdrive has no cache, and have not been measured against a deployed config. In that
  window a hide or a removal can still show on those pages, and so can an old rating or
  warning (the warnings screen is decided from the cached read). A removal's cache purge
  can be undone for the same window: a chapter request that read the work before the
  removal can store a fresh edge entry after the purge. A work that has just gone live
  can also show late, including a cached "no such work" from before it did, and a
  replaced version's old title can show, and a work just restored or un-hidden can still
  answer 451 or 410, each up to about 75 s on public pages. The
  upload status page links to the work page, so someone can meet this just after
  "done". New code that reads
  through `HYPERDRIVE` without knowing about this is fresh, and so safe.
- **Operator steps: one ordered list.** Keep this order: each step needs what the
  one before made, and once Workers are live a step out of order serves reads from the
  wrong config. (Before launch nothing is live, so a slip costs nothing but the ids must
  still exist first.) **Pasting one id into both configs puts
  every read back in the cache, and no test can see it**: ids in the repo are
  placeholders, and caching is a property of the deployed config.
  1. Create a second config on the same database with caching on (`wrangler hyperdrive
     create <name> --connection-string=<url>`).
  2. Put real ids in all four wrangler files: the second config's id on `HYPERDRIVE_CACHED`
     in `apps/web`, and the existing config's id on `HYPERDRIVE` in `apps/web`,
     `apps/ingest`, `apps/sweep` and `apps/content`. Check the two ids differ.
  3. Deploy `apps/web` with both bindings.
  4. Turn caching off on the existing config (`wrangler hyperdrive update <id>
     --caching-disabled`). Check that only `HYPERDRIVE_CACHED`'s config has caching on.
  5. Deploy `apps/content`, `apps/ingest` and `apps/sweep`.
  6. Purge the content host's whole cache, so entries stored under older headers go.
  7. Live checks, which can't be measured locally:
     - the purge by URL and by prefix reaches the content Worker's Cache API entries
       (see *Surge controls*, Edge cache);
     - the 12-hour refill: each data centre misses once per file per 12 hours. `HEAD`,
       `Range` and conditional requests, and every refusal (404 for a file that isn't
       there, 451, 503), are never cached and read every time, so a scraper walking ids
       costs a database read and an R2 read per request (the R2 read starts with the
       status read and is dropped on a refusal); the extra reads are unknown until launch;
     - `Cache-Control` and `Age` on the content host's responses and on the web Worker's
       cached pages;
     - the Hyperdrive window of about 75 s (the figures above are from the docs) on a
       public page after a hide;
     - the pool: a Hyperdrive config's pool is shared by every Worker on it, so content
       misses compete with web's sign-in and admin for connections and for Neon's limit.
       Watch Neon's connection count and the Worker's 503s; if they compete, a third
       uncached config for content is the fix, with its own id here.
     If the purge does not reach those entries, the old ones end within 12 hours of
     their store.

  Also before launch, not tied to the order above:
  - **The real Turnstile key.** `TURNSTILE_SITE_KEY` in `apps/web/wrangler.jsonc` is the
    rarepair.fans widget's, and its secret is the `TURNSTILE_SECRET_KEY` secret. Without a
    matching pair every Turnstile form (sign-in, upload, the wait list, `/remove`, `/dmca`)
    fails closed.
  - **The notices mailbox.** `admin@rarepair.fans` (the `NOTICES_EMAIL` var) must exist
    and be read. Requests to delete an account come here too (Auth, Deleting an account); the
    privacy page names the address itself. The copyright notice page names it for a visitor without JavaScript and
    on a refusal that stops the form working (rate limit, failed or unreachable Turnstile check). Mail sent there doesn't reach the takedowns queue: a person reads it
    and enters the notice.
- Queries that select `now()` or another non-immutable function are never cached by Hyperdrive.
  Some reads here still select `now()` beside a read for that reason; they stay correct
  on an uncached connection and are redundant there.

## MVP vs later

**MVP (ship in days)**
1. Magic-link sign-in, with a one-time terms page for new accounts
2. Upload: presigned PUT, then queue, then parse, sanitize and dedupe
3. Work page: metadata, tags, warnings, link to the original AO3 URL
4. Reader: chapters, reader settings, warnings interstitial, saved position,
   download original
5. Browse by fandom, tag or rating, sorted by updated date or word count
6. Search: title, author, tags, summary (Postgres FTS plus trigram)
7. Remove-my-work and opt-out requests, reports, DMCA form, minimal
   moderation queue, public removal list
8. Terms, a privacy notice and a clear "unofficial, temporary" banner

**Later**
- Bookmarks, kudos and per-user reading history
- Series pages and collections
- Tag synonym merging and filtering by excluded tags
- Comments (needs much more moderation, so leave it out unless people ask)
- Bulk upload from a zip of epubs
- FanFicFare epubs of AO3 works (second preface parser, keyed on `dc:source`)
- Export and shut down: nothing changes automatically when AO3 returns (the
  AO3 links simply start working). The operator starts the wind-down by hand:
  redirect every work to its AO3 URL, then shut the site down

## Proposed repo layout

```
apps/web/          Hono Worker: pages, auth, upload handshake, search, admin
apps/content/      Worker serving epub images and original downloads from R2
apps/ingest/       Queue consumer: epub processing
apps/mailer/       Queue consumer: sends email (Resend)
apps/sweep/        Daily cron: deletes unreferenced images, orphaned upload prefixes and removed works' leftovers from R2, and uploads left unconfirmed
packages/epub/     unzip + OPF + AO3 preface parser + sanitizer (tested in workerd)
packages/db/       SQL migrations + typed queries
fixtures/epubs/    real AO3 epub samples for parser and sanitizer tests
docs/
```

TypeScript throughout. The HTML is server-rendered with Hono's JSX, with only a
little client JS for upload progress and the reader settings.

## Open questions

- **Locked works.** Some AO3 works are visible only to signed-in AO3 users.
  Can we tell from the epub that a work was locked? If we can, should we keep
  those works behind a sign-in here too? This needs checking against sample
  files.
- **Anonymous and unrevealed works.** Their prefaces show "Anonymous". We
  should keep that as it is and never try to identify the author.
- **Deleted or orphaned works.** Someone may upload a work the author deleted
  from AO3. While AO3 is down we can't check, so we rely on the opt-out list and
  remove-my-work requests.
