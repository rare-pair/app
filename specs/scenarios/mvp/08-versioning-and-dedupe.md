# Scenario: Versioning and dedupe (duplicate, held_for_review)

Relates to: docs/ARCHITECTURE.md § Decisions so far (New versions), § Dedupe, § Ingestion pipeline (step 3), § EPUB processor (Review reasons, step 7), § Author requests & takedowns (No claims while AO3 is down, What hidden, held and removed works show, Moderation)

## Setup
- A live work W with `ao3_work_id` 12345, current version v1 with 3 chapters and an Updated date of D1
- Fixtures of work 12345:
  - v2-newer: 4 chapters, chapters 1-3 near-identical to v1 after sanitizing
  - v2-later-date: 3 chapters, later Updated/Completed date, chapters near-identical
  - v2-small-edit: 4 chapters, chapter 2 has a small typo fix
  - v2-tampered: 4 chapters, chapter 2 rewritten
  - v2-tags-changed: 4 chapters, chapters near-identical, one tag different
  - v2-authors-changed: 4 chapters, chapters near-identical, different author
  - v0-older: 2 chapters, earlier Updated date
  - v2-flagged: 4 chapters, chapters 1-3 near-identical, but `Stats:` says 5 chapters, so the parser adds a `chapter_count_mismatch` review reason
- The exact bytes of v1's file (same SHA-256)
- A signed-in moderator M and a signed-out reader

## Cases

### First upload creates the work
- GIVEN no work exists with `ao3_work_id` 67890
- WHEN an AO3 epub of work 67890 is ingested
- THEN a work keyed by `ao3_work_id` 67890 is created with its first version

### Newer upload with more chapters replaces the current version
- GIVEN work W at v1
- WHEN v2-newer is ingested
- THEN a new version is added and `current_version_id` points at it
- AND the upload's status is `live`

### Newer upload with a later date replaces the current version
- GIVEN work W at v1
- WHEN v2-later-date is ingested
- THEN `current_version_id` points at the new version

### Small edits in shared chapters are allowed
- GIVEN work W at v1
- WHEN v2-small-edit is ingested
- THEN the per-chapter normalized-text comparison is within the similarity threshold
- AND `current_version_id` points at the new version

### A card reads 12/? when the version states no total
- GIVEN work W at v1, whose Stats line gives a total of 3 chapters
- WHEN a newer version with 4 chapters is ingested from a file whose Stats line states no total
- THEN `current_version_id` points at the new version and W's chapter total is NULL
- AND W's card reads "4/? chapters", not "4/3"
- AND the other columns the file lacks keep W's values

### Newer upload with changed shared chapters is held
- GIVEN work W at v1
- WHEN v2-tampered is ingested
- THEN the upload's status is `held_for_review`
- AND `current_version_id` still points at v1

### Held version is never public
- GIVEN work W at v1 and v2-tampered held for review
- WHEN the signed-out reader opens W's work page, its chapters and `/full`
- THEN only v1 is served, and nothing from the held version is reachable by the public (404)
- AND the held version is listed for its uploader on `/me/uploads` and for moderators in *Works to check*

### Flagged newer upload replaces and shows the notice
- GIVEN work W at v1
- WHEN v2-flagged is ingested
- THEN `current_version_id` points at the new version and the upload's status is `live`
- AND W's work and reader pages show the notice "Chapters may be imperfect; a moderator will check."
- AND W is listed in *Works to check*
- AND the upload is not `held_for_review`, because review reasons never hold an upload

### Newer upload with changed tags is held
- GIVEN work W at v1
- WHEN v2-tags-changed is ingested
- THEN the upload's status is `held_for_review`
- AND `current_version_id` still points at v1

### Newer upload with changed authors is held
- GIVEN work W at v1
- WHEN v2-authors-changed is ingested
- THEN the upload's status is `held_for_review`
- AND `current_version_id` still points at v1

### Older upload is marked duplicate
- GIVEN work W at v1
- WHEN v0-older is ingested
- THEN the upload is marked `duplicate`
- AND it is stored but not used
- AND it is not a rejection: the uploader sees "Already in the archive" with a link to W
- AND `current_version_id` still points at v1

### Same-version upload is marked duplicate
- GIVEN work W at v1
- WHEN a different file of work 12345 with the same chapter count and the same Updated date is ingested
- THEN the upload is marked `duplicate`
- AND it is stored but not used, and the uploader sees "Already in the archive" with a link to W

### Byte-identical re-upload is marked duplicate at confirm
- GIVEN work W at v1
- WHEN a file with the same SHA-256 as v1's file is uploaded and `POST /uploads/:id/complete` is called
- THEN the upload is marked `duplicate` straight away, with its `work_id` set to W
- AND no ingest run happens and no second copy of the file is kept
- AND the uploader sees "Already in the archive" with a link to W
- AND `current_version_id` still points at v1

### Nobody gets special treatment
- GIVEN two uploaders, one claiming to be the author of work W and one not
- WHEN each uploads v2-tampered
- THEN both uploads are `held_for_review` in exactly the same way

### Every version is kept
- GIVEN work W after v2-newer replaced v1
- WHEN the work's versions are listed
- THEN both v1 and the new version exist, each with its own `r2_prefix` of `works/<ao3_work_id>/<upload_id>/` keyed by the upload that produced it
- AND version numbers live only in Postgres, not in any R2 key

### Work admin page lists every version
- GIVEN work W after v2-newer replaced v1
- WHEN moderator M opens W's admin page
- THEN both versions are listed with their date, uploader and chapter count, each with a "Make current" action

### A moderator rolls back a bad replacement
- GIVEN work W whose current version was replaced by a bad upload
- WHEN moderator M uses "Make current" on the earlier version on W's admin page
- THEN `current_version_id` points at the earlier version again and its chapters are served

### Only moderators can roll back
- GIVEN work W with two versions, and a signed-in user without the moderator role
- WHEN that user opens W's admin page or posts its "Make current" action
- THEN the response is 404 and `current_version_id` is unchanged

### Two uploads of the same work processed at once
- GIVEN work W at v1
- WHEN v2-newer and v2-later-date are ingested concurrently
- THEN `current_version_id` points at exactly one complete version, and every chapter served belongs to that version
