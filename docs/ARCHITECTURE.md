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
| Who can read uploads | Shared public archive. Every upload is readable by everyone, with takedowns and author removal requests from day one |
| Hosting | Cloudflare: Workers, R2, Queues, KV, plus Neon Postgres through Hyperdrive |
| Load target | Surge-ready: assume tens of thousands of signups in the first days |
| Sign-in | Email magic link with no passwords stored, through Better Auth (self-hosted in the Worker, data in Neon) and Resend |
| Accepted files | AO3-native epub exports only. FanFicFare support comes later |
| New versions | Replace the current version automatically only if newer and consistent with it. Otherwise hold for review |
| Author identity | No work claims and no author verification while AO3 is down. Removal and opt-out are requests anyone can make, without proving who they are |
| Search scope | Metadata only: title, author, tags, summary |
| Chapter rendering | Inline in app pages behind a strict CSP, with no iframe |
| Wait list | Before launch, `/` is a coming-soon page with a double opt-in wait list. Each confirmed address is sent one launch email, from the same mail subdomain as sign-in, spread over hours on its own queue. The list is deleted after the launch send |

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
   │  web Worker ── Queues: email, email-bulk ──▶ mailer Worker ──▶ Resend (Postmark or SES failover)
   │  upload: presigned PUT from the browser (needs JS, like every Turnstile form)
   ├────────────────────────────────────────────────▶ R2: uploads/  (raw epubs)
   │
   │             ┌───────────────────── content.rarepair.fans ──────────────────────┐
   └──────────▶  │  content Worker: epub images + original-file downloads from R2   │
                 │  separate origin, no cookies, nosniff, edge-cached forever       │
                 └──────────────────────────────────────────────────────────────────┘
```

### Why these pieces

- **R2 for all bytes.** It has no egress fees, which matters most when the
  workload is mostly serving books. Fresh uploads land in `uploads/`, which
  expires on its own. Original files we keep go in `originals/`, and processed
  chapters go under `works/<ao3_work_id>/<upload_id>/`: one prefix per version,
  keyed by the upload that produced it, so a retried job overwrites only its own
  files. `work_versions.r2_prefix` records it; version numbers live only in
  Postgres. The AO3 work ID is known once the preface is parsed, before anything
  is written.
- **Neon Postgres over D1.** D1 is capped at 10 GB per database, the cap can't
  be raised, and each database runs one query at a time. AO3 has more than 15M
  works. Even metadata-only rows (title, summary, tags) for a large share of
  them would pass 10 GB, and sharding search across D1 databases is work we
  don't need. Postgres also gives us `tsvector` full-text search and `pg_trgm`
  fuzzy matching. Chapter text lives in R2, not in the database.
- **Queues for ingestion.** Parsing happens off the request path, so a flood of
  uploads becomes a backlog, not an outage. Queue consumers get up to 15 minutes
  of CPU per invocation and 128 MB of memory, which is plenty for an epub capped
  at 25 MB.
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
    challenge pages, must not apply to `content.rarepair.fans`: turn them off,
    or skip that host with a rule. Turnstile and the web Worker's rate limits do
    that job instead.

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
              current_version_id, raw_meta jsonb,
              search tsvector,   -- title A, byline and tags B, summary C; text search config `simple`
              search_text)       -- the same text, for pg_trgm fuzzy matching
work_authors (work_id, pseud, ao3_user NULL,
              position)  -- the author's place in the byline, from 0; unique per work
work_versions(id, work_id, upload_id, chapter_count,
              chapter_total NULL,  -- the planned total as this version's preface gave it
              r2_prefix, created_at,
              review_reasons text[],  -- from the parser; non-empty shows the notice
              checked_at NULL,        -- set when a moderator approves the version
              tags jsonb, authors jsonb)  -- this version's own tags and byline, in the file's order; work_tags and work_authors hold only the current version's
chapters     (work_id, version_id, n, title, words, r2_key)
tags         (id, type, name, name_norm) -- type: fandom|relationship|character|freeform|warning|category|rating
work_tags    (work_id, tag_id,
              position)  -- the tag's place in the work's tags, in the author's order
uploads      (id, user_id, r2_key, sha256, bytes, status, lease_until,
              error_stage, error, work_id NULL, created_at)
reports      (id, work_id, reporter_id, kind, body, status, created_at)  -- reporting needs an account;
                                                  -- kind includes wrong_version ("This version is wrong")
takedowns    (id, work_id, requester, basis, status, resolved_by, created_at,
              signature, infringing_material, good_faith, accuracy_authority,
              incomplete)  -- a DMCA notice: basis is the copyrighted work, requester the contact
                           -- information; incomplete when a 512(c)(3)(A) element is missing
requests     (id, kind, work_id NULL, pseud_norm NULL, contact_email, statement,
              status, ip_hash, created_at)        -- kind: remove_work | opt_out
optouts      (id, pseud_norm, ao3_user NULL, request_id, active, created_at)  -- checked at ingest
requester_blocks (id, contact_email NULL, ip_hash NULL, created_by, created_at)
waitlist     (email PRIMARY KEY,               -- trimmed and lowercased; deleted after launch
              confirm_token_hash NULL, confirm_sent_at,
              confirm_count,                    -- confirmation emails sent, 3 at most
              confirmed_at NULL, notified_at NULL,
              unsubscribe_token_hash NULL, created_at)  -- no IP, user agent or referrer
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
(Ingestion pipeline, step 3).

**Tags.** AO3's tag wrangling (canonical tags and synonyms) can't be rebuilt in
a week. Store tags exactly as written, plus a normalized form (`name_norm`:
in Unicode NFKC, lowercased, whitespace and punctuation folded) used for matching. Moderators can
merge synonyms later. Relationship tags keep `/` and `&` when `name_norm` is
computed, so "Kirk/Spock" and "Kirk & Spock" are different tags (whitespace
and punctuation beside them still fold away, so "Kirk / Spock" matches
"Kirk/Spock"); other tag types fold them like any punctuation.

**Pseuds.** Opt-outs match on `pseud_norm`: the pseud in Unicode NFKC,
case-folded, with leading and trailing whitespace trimmed and inner runs of
whitespace collapsed to one space. Unlike `name_norm`, punctuation is kept, so
`a_b` and `a b` are different pseuds. The same rule is applied to the opt-out
request and to every byline at ingest.

## Ingestion pipeline

1. **Ask.** `POST /uploads` checks the session, Turnstile, the daily quota and
   the declared size (25 MB or less). The upload page's script calls it, so a
   signed-out request gets 401 rather than a redirect it can't follow (the
   page itself redirects to sign in), a failed or missing Turnstile token gets 400, a declared size over
   25 MB gets 413 and a spent quota gets 429 with `Retry-After` (Surge
   controls); the upload page shows the message. Otherwise it inserts an
   `uploads` row and returns a presigned R2 `PUT` URL, valid for 10 minutes
   and locked to `Content-Type: application/epub+zip`. R2 presigned URLs support PUT but not
   form POST, and the bucket needs a CORS rule for `rarepair.fans`.
2. **Upload.** The browser PUTs the file straight to R2 and shows progress.
   Uploading needs JavaScript, as every form with a Turnstile check does
   (Turnstile can't produce a token without it); without JS the upload page
   says so (FRONTEND-DISCOVERY, *Where the frontend changes the architecture*).
3. **Confirm.** `POST /uploads/:id/complete` HEADs the object, checks its size,
   and hashes it (SHA-256). If the hash matches an earlier upload that was
   ingested into a work that is `live` or `hidden` (that upload's status is
   `live`, `held_for_review` or `duplicate`, with a `work_id`), the new upload
   is marked `duplicate` straight away, with `work_id` set to that work:
   nothing is enqueued, there is no ingest run, and the object is never copied
   to `originals/`, so no second copy is kept. The uploader sees the "Already
   in the archive" badge with a link to the work. Any other match (an upload
   still `pending` or `processing`, one that was rejected, or one whose work
   was removed) gets no shortcut: the new upload is enqueued like any other,
   and the versioning rules or the same rejection decide it. Otherwise it
   enqueues `{upload_id}`.
4. **Process.** The ingest consumer runs with a batch size of about 5, retries,
   and a dead-letter queue. See the EPUB processor section below.
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
   its own files and never touches another run's.
2. **Unzip with limits.** Read the object from R2 (25 MB or less) and check
   the zip's file index before decompressing anything:
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
   - Then check the opt-out and takedown lists. A match rejects the file with
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
   preface and OPF (`work_id_mismatch`), and so on. They are stored on the version (`work_versions.review_reasons`).
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
   them, a retried job rewrites the same keys, and they can be cached as
   `immutable`. Images no version references (say, from a job that failed
   before its transaction) are removed by a periodic sweep, and all of them go
   when the work is removed.
7. **Versioning.** Each work is keyed by `ao3_work_id`. The first upload
   creates the work. A later upload:
   - **replaces the current version** only if it is newer (more chapters or a
     later Updated/Completed date) **and** the chapters both versions share
     come out as near-identical text after sanitizing. Small edits are allowed;
     compare a hash of the normalized text per chapter plus a similarity
     threshold.
   - **is held for review** (`held_for_review`) if it is newer but its shared
     chapters differ, or if its tags or authors changed. This blocks someone
     editing an epub to tamper with a work. A held version is never public:
     the work keeps serving its current version, the held one is listed only
     for its uploader (My uploads) and for moderators (*Works to check*), and
     only a moderator's approval makes it current.
   - **is marked `duplicate`** if it isn't newer. It's stored but not used.
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
   - **Not newer is a `duplicate`** even when its tags or authors changed.
     When several checks fail, the held reason is the first of: chapters, tags,
     authors.

   Every version is kept, so a bad replacement can be rolled back. Only
   moderators roll back: a work's admin page lists every version (date,
   uploader, chapter count) with a "Make current" action that repoints
   `current_version_id`. Readers who spot a bad version report it as "This
   version is wrong" (Author requests & takedowns, Reports).
8. **Save, in order.** Write chapter fragments and images to R2. Then run one
   Postgres transaction that upserts the work, adds the version, chapters and
   tags, and points `current_version_id` at the new version. Set the work
   `live` last. If the job fails before the transaction, R2 is left with
   orphaned files under its `<upload_id>/` prefix, which the cleanup rules
   delete. A
   job that fails for good goes to the dead-letter queue as `parse_failed`,
   with the stage and error recorded on the upload row.

   A later upload of a known work is decided in the same transaction, from
   facts read before it (the current version's chapter text comes from R2,
   never read under a lock). A `replace` adds the version and chapters, then
   moves `current_version_id` with one compare-and-swap (`update ... where
   current_version_id = <the one read>`), then rewrites the work's columns,
   byline and tags from the new version and refreshes its search text; the
   upload is `live`. A job that loses the swap rolls back, reads the work
   again and decides again, so two uploads at once leave one current version.
   A `hold` adds the version and chapters and leaves the work, its byline and
   tags alone (the version keeps its own in `work_versions.tags` and
   `authors`); the upload is `held_for_review`. A `duplicate` adds no
   version; the upload is `duplicate`, with its `work_id` set and its files
   kept. A replace never changes the work's status: a hidden or removed work
   stays so. Only a work's first upload sets it `live`.

**Rejection codes:** `not_epub`, `zip_bomb`, `too_large`, `not_ao3`,
`opted_out`, `parse_failed`. Each one shows a plain-language message to the
uploader. Step 2 lists which problem gives which of the first three.
`not_ao3` covers any file without an AO3 preface "Posted originally" line,
including one whose AO3 work URL is only in the OPF (step 4). `opted_out`
covers the opt-out list and the takedown list of moderator-removed works.
`parse_failed` also covers a job that fails for good (step 8). (`held_for_review`
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
  selection, screen readers, translation tools and reader extensions all work
  normally. Pages also stay fast on cheap phones.
- **Strict CSP on every app page** (a fresh nonce per response):
  `default-src 'self'; script-src 'nonce-{n}' 'strict-dynamic'; style-src 'self';
  img-src 'self' https://content.rarepair.fans; object-src 'none'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'`. Injected markup can't guess the
  nonce, so any script that gets past the sanitizer won't run. Session cookies
  are `HttpOnly`, so scripts can't read them anyway.
- **Pages with a Turnstile check** (sign-in, upload, `/remove`, and the
  coming-soon page at `/` while `PRELAUNCH` is on, with `/waitlist`, where a
  refused join shows its form again) add exactly one
  allowance, `frame-src https://challenges.cloudflare.com`, for the challenge
  iframe. Turnstile's `api.js` loads through a nonced `<script>`, which
  `'strict-dynamic'` already covers. Reader and work pages never get it.
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
- **We can re-sanitize everything.** Originals are kept in `originals/`, so
  when a bypass is found we fix the sanitizer and re-run ingest on every stored
  work from a backfill queue.
- **Caching.** Fragments in R2 never change once written, since each version
  has its own prefix. The Worker caches them with the Cache API. Reader
  settings (font, spacing, theme) come from a cookie. The server writes them as
  `data-*` attributes on `<html>`, or a script flips the attributes when they
  change, and the stylesheet's CSS variables key off those attributes. Inline
  `style` is never used, since the CSP blocks it. So the same chapter fragment
  serves every reader. Pages
  for signed-out readers can get a short edge cache, apart from the nonce: use
  a cached template with the nonce swapped in, or cache only the fragment.
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
  A signed-in reader can turn warnings off; the choice is stored on their
  account (`user.warnings_off`), not in the settings cookie. Signed-out readers can't turn them off.
- **"May be imperfect" notice.** When the current version has review reasons
  that no moderator has cleared (EPUB processor, step 5), the work page and
  every reader page show one line: "Chapters may be imperfect; a moderator will
  check."
- The reader has font size, line spacing, light/dark/sepia themes, and a
  one-page "entire work" view. These settings are stored in a cookie. (The
  warnings choice above is the exception: it lives on the account.)
- Signed-in users get their reading position saved to KV, keyed by
  `user:work`, with a short debounce.
- "Download original epub" serves the file from `originals/` with
  `Content-Disposition: attachment` from `content.rarepair.fans`. It's never
  displayed inline.

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
    the form again with an error, as in Surge controls)
  - it reduces `next` to a same-site path (root-relative only: no `//`, no
    `\`, no control characters) before passing it on. The `//` check runs
    again after URL normalization, because `/a/..//evil.example` normalizes
    to `//evil.example`.
  Tokens last 15 minutes and are stored hashed (`storeToken: "hashed"`) in
  Better Auth's `verification` table.
- **Using the link.** The email links to our `GET /login/confirm?token=…`,
  which only shows a "Sign in" button: a POST form that uses nothing up. Mail
  scanners that open links in advance therefore can't burn it.
  `POST /login/confirm` calls `auth.api.magicLinkVerify`, which redirects to
  `next` with the session cookie. A used, expired or unknown link is
  redirected to `/login` with a plain message.
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
  `/privacy` and signing out. Accepting sets `user.terms_accepted_at` and
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
- **Better Auth's own rate limiter** only covers requests through
  `auth.handler`. Its default memory store is per isolate on Workers, so set
  `rateLimit.storage: "database"` (or a Durable Object through
  `customStorage`), with `ipAddressHeaders: ["cf-connecting-ip"]`.
- **Email: Resend primary.** The web Worker puts each email on an `email`
  queue. A dedicated **mailer Worker** (`apps/mailer`) consumes it and sends
  through a small sender interface. Volume isn't the risk; sending limits are.
  - **Why it's its own Worker:** sign-in mail must keep flowing during an
    upload surge, so it shares no deploy, concurrency limit or failure with
    `apps/ingest`. It also keeps the email-provider keys out of the web
    Worker. The mailer only sends: it has no database or R2 access.
  - **Reader privacy:** the mailer never logs email addresses or links; it
    logs provider message IDs and outcomes only.
  - **Failures:** a message that fails on both providers is retried by the
    queue, then moved to a dead-letter queue, never dropped silently. Queued
    messages hold an address and a link (a sign-in link expires after 15
    minutes, a wait list confirmation link after 7 days), so the dead-letter
    queue keeps them for one day at most, and
    nothing prints its contents to logs.
  - The mailer sends with Resend's batch API, to stay under its
    per-second API limit (by default about 2 requests a second; ask for more
    before launch).
  - Mail goes from a dedicated subdomain with SPF, DKIM and DMARC, warmed up
    before launch. The wait list's confirmation emails do that warm-up, and
    the launch email goes from the same subdomain (Wait list).
  - **Two queues.** `email` carries sign-in and wait list confirmation emails.
    `email-bulk` carries only the launch email, and its consumer sends at a
    configured rate that leaves room under Resend's per-second limit, so a
    launch send never delays a sign-in link.
  - Postmark or SES is wired in as failover from day one.
  - Cloudflare Email Sending isn't used for launch: it's in beta, and new
    accounts start on a "conservative daily quota" that a signup surge would
    hit.
  - The login page tells people that links can take a minute to arrive during
    busy periods.
- Accounts are needed only to upload, report, save reading position or turn
  the warnings screen off. Reading never needs an account.

## Author requests & takedowns

The archive shows people's work without asking them first, so these features
are part of the MVP, not extras.

**No claims while AO3 is down.** AO3 is the only place that could vouch for who
wrote a work, and it's offline. Rather than accept weak proof, we don't offer
work claims, author accounts or author self-service at all. Authors don't need
an account. Whoever asks gets the same thing: a work hidden or an opt-out
applied. Authors update a work the same way anyone does, by uploading a newer
epub, under the normal versioning rules.

- **Remove my work.** A public form at `/remove` asks for the work's URL here
  or its AO3 URL, a contact email and a short statement. No sign-in, but
  Turnstile is required. The work is hidden **at once** and a moderator
  reviews the request. We err on the side of the person asking. If the AO3 URL
  given isn't a work in the archive, nothing is stored: the confirmation says
  the work isn't here and suggests opting out the pseud instead, which also
  covers future uploads.
- **Opt out.** The same form, given a pseud instead of a work. It hides every
  existing work by that pseud at once, and the opt-out list is checked again
  at ingest for new uploads. A moderator confirms it. A mistaken opt-out can be
  reversed.
- **Abuse of instant hiding.** Since nobody has to prove who they are, anyone
  can hide any work for a while. Limits: requests are rate-limited per email
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
- **Block and ban stop only the action.** Blocking a requester (by contact
  email and IP hash) means their later `/remove` requests, and reports from an
  account with that email or IP hash, are still recorded and queued but no
  longer hide anything (an opt-out from them isn't applied until a moderator
  approves it). Every requester sees the same confirmation (FRONTEND-DISCOVERY,
  journey 4), and the page never reveals that a requester is blocked. Banning
  an uploader (an account, `banned_at`) stops it uploading and reporting; its
  existing uploads stay until a moderator acts on them.
- **What hidden, held and removed works show.**
  - **Hidden** (`hidden`, by a removal request or opt-out, by reports, or by a
    moderator): 451 on the work page, every chapter URL and `/full`, with one
    line that names the cause (`works.hidden_cause`): "Temporarily hidden after
    a removal request", "Temporarily hidden after reader reports" or
    "Temporarily hidden by a moderator". Nothing else about the work is shown,
    and it is left out of search, listings and the home page.
  - **Held** (a `held_for_review` version, never public): 404 to the public.
    The work keeps serving its current version. The held version is visible
    to its uploader in My uploads and to moderators.
  - **Removed** (`removed`): 410 on the work page, every chapter URL and `/full`,
    "This work has been removed".
  - **The report routes** (`GET` and `POST /works/:id/report`) answer 404 for a
    hidden or removed work, as for one that doesn't exist: only the work,
    chapter and full pages show 451 or 410.
- **Removal really removes.** Setting a work to `removed`, through a takedown,
  an author request or a moderator, also deletes `works/<ao3_work_id>/` and the raw
  upload from R2, and purges the work's pages, cached fragments, images and
  download URLs from the cache. Images and downloads are cached as
  `immutable`, so without the purge parts of a removed work stay reachable.
- **DMCA.** To get safe-harbor protection under US law (17 U.S.C. §512), we need
  a designated agent registered with the US Copyright Office, a public takedown
  form, a counter-notice process and a repeat-infringer policy. Get a lawyer to
  review this before launch. A notice from `/dmca` lands in the takedowns
  queue and does **not** hide the work by itself (unlike `/remove`): a
  moderator decides whether to hide or remove it. While no moderator has acted
  on it, the notice doesn't block re-uploads of the work either. Once a
  moderator removes the work, its AO3 work ID goes on the takedown list, and
  later uploads of it are rejected `opted_out` (EPUB processor, step 4). A
  notice missing statutory elements is still queued, marked incomplete. The
  form has no Turnstile, so it works without JavaScript; a rate limit per IP
  is its only abuse control. The counter-notice process and
  repeat-infringer policy are part of the lawyer review.
- **Reports.** Every work has a report button. Reporting needs a signed-in
  account, so each report has a reporter who can be rate limited or blocked;
  signed-out readers, opening the form or POSTing a report, are redirected to
  sign in, carrying `next`, and brought back to the form. A work with open
  reports from **3 distinct signed-in accounts** is hidden automatically until
  a moderator looks at it; several reports from one account count once.
  Reports from banned accounts can't be made, and reports matching a blocked
  requester don't count. One reason is "This version is wrong"
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

  Actions are hide, remove, restore, approve, reject, block a requester and ban
  an uploader. A *Works to check* item's page has approve (clears the notice,
  or publishes the held version), make a version current, hide and remove;
  each work's admin page lists every version with "Make current". Anyone
  without the moderator or admin role, signed out included, gets 404 for every
  `/admin` URL, so the admin area isn't advertised.

## Wait list

The site goes up before the archive opens. While the web Worker's `PRELAUNCH`
setting is on, `/` is a coming-soon page with a wait list form, and every
other app page redirects there, except `/terms`, `/privacy`, the `/waitlist`
pages, sign-in, `/welcome/terms`, sign-out and `/admin`, so an admin can sign
in for the first time. Turning `PRELAUNCH` off opens the archive: `/`
becomes the home page and `POST /waitlist` answers 404.

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
  mailer's message contract would accept it.
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
  they bring, arrive over hours. A launch email that both providers refuse
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
  `Origin` check because mail providers send it; opening the link in a
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

- Turnstile on signup, login, upload, the wait list and `/remove` requests. Turnstile needs
  JavaScript, so those forms do too; reading, browsing and search work without
  it. Each form's widget names its own action (`login`, `waitlist`, `upload`
  and `remove`) with `data-action`, and the Worker passes
  a token only when siteverify reports that action and this host, so a token
  solved on one form is refused by every other. Cloudflare's published test
  secret keys, which don't promise an action, skip the action comparison only.
- The Workers rate-limiting binding covers abuse throttling on login, the
  wait list, removal requests, DMCA notices, upload requests and search, keyed
  per IP and per user (per email for login, the wait list and removal
  requests). It's approximate and counts per Cloudflare location, over 10- or
  60-second windows. That's fine for slowing abuse, but not for hard limits.
- **Status codes.** A rate limit or quota that is hit returns **429** with
  `Retry-After` and a plain page saying when to try again. A failed or missing
  Turnstile token returns **400** and shows the form again with an error (as does
  a 503 when Turnstile can't be reached and a 413 for a body too large; the form
  may hold what was typed, so each is sent `Cache-Control: no-store`), and
  so does a form missing required fields (such as `/remove` without a contact
  email, or without a work or pseud). A sign-in POST from any other origin (a
  bad `Origin` / `Sec-Fetch-Site`, as in Auth) gets **403**. An upload request
  declaring more than 25 MB gets **413**. A used, expired or unknown magic link is
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
- **Orphaned uploads.** A presigned PUT can't enforce a size limit, and a
  client may never call `/complete`. So `/complete` deletes oversized objects,
  and an R2 lifecycle rule expires anything under `uploads/` after 7 days.
  Raw files the archive keeps are copied to `originals/` during ingest.
- Queue backpressure: set a maximum consumer concurrency so Neon connections
  stay bounded. Hyperdrive pools connections, and Neon autoscales compute.
- Edge cache: images and original downloads on `content.rarepair.fans` never change
  once written, since each version has its own prefix, so they're cached with
  `Cache-Control: public, max-age=31536000, immutable`. Chapter fragments are
  cached inside the web Worker (see Reading). Work and tag listings
  get a short cache with stale-while-revalidate.
- Observability: Workers Logs and traces are on from day one. Track queue
  depth, ingest failure rate and search p95 on a dashboard.

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
   moderation queue
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
apps/mailer/       Queue consumer: sends email (Resend, with failover)
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
- **Legal review.** Get a review of the DMCA setup and terms before public
  launch.
