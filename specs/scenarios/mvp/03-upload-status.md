# Scenario: Upload status and rejection messages

Relates to: docs/ARCHITECTURE.md § Ingestion pipeline (step 5), § EPUB processor (Rejection codes), § Auth (Signed-out requests to signed-in pages); docs/FRONTEND-DISCOVERY.md § Key journeys (3. Upload works), § Page inventory (My uploads), § Where the frontend changes the architecture (3. Upload status without JS), § Components (Status badge), § Copy and tone

## Setup
- A signed-in user U with several uploads in different states
- A second signed-in user V with uploads of their own
- `GET /uploads/:id` and `/me/uploads` are served by the web Worker

## Cases

### Status endpoint reports processing
- GIVEN an upload by U that is being parsed
- WHEN U polls `GET /uploads/:id`
- THEN the status is `processing`

### Status endpoint reports live
- GIVEN an upload by U that has been ingested and its work set live
- WHEN U polls `GET /uploads/:id`
- THEN the status is `live`

### Status endpoint reports held for review
- GIVEN an upload by U that the versioning rules held
- WHEN U polls `GET /uploads/:id`
- THEN the status is `held_for_review`

### Status endpoint reports duplicate
- GIVEN an upload by U of a work that is already in the archive and that the versioning rules marked as not newer
- WHEN U polls `GET /uploads/:id`
- THEN the status is `duplicate`, not a rejection code

### My uploads lists every upload with a text status badge
- GIVEN user U with uploads that are processing, live, held, duplicate and rejected
- WHEN U opens `/me/uploads`
- THEN each upload is listed with a text-only badge such as "Processing", "Live", "Held for review" or "Already in the archive"

### My uploads shows only the signed-in user's uploads
- GIVEN users U and V each with their own uploads
- WHEN U opens `/me/uploads`
- THEN only U's uploads are listed

### Live upload links to its work
- GIVEN an upload by U whose status is `live`
- WHEN U views it on `/me/uploads`
- THEN U can open the work from there

### My uploads refreshes itself while something is processing (no JS)
- GIVEN user U with at least one upload in `processing` and JavaScript off
- WHEN U opens `/me/uploads`
- THEN the page includes `<meta http-equiv="refresh" content="5">` inside `<noscript>`, so it applies only without JS (with JS the page updates in place instead)

### My uploads stops refreshing when nothing is processing
- GIVEN user U whose uploads are all live, held, duplicate or rejected
- WHEN U opens `/me/uploads`
- THEN the page has no `<meta http-equiv="refresh">`, in `<noscript>` or elsewhere

### My uploads updates in place with JS
- GIVEN user U with an upload in `processing` and JavaScript on
- WHEN the upload's status changes to `live`
- THEN the status on `/me/uploads` updates without a full page reload

### Rejected not_ao3 upload shows a plain-language message
- GIVEN an upload by U rejected with `not_ao3`
- WHEN U views it on `/me/uploads`
- THEN the badge reads "Rejected: not an AO3 export"
- AND the message says what happened and what to do next, in the style of "This file isn't an AO3 download, so we can't accept it here."

### Rejected not_epub upload shows a plain-language message
- GIVEN an upload by U rejected with `not_epub`
- WHEN U views it on `/me/uploads`
- THEN a plain-language message says what happened and what to do next

### Rejected zip_bomb upload shows a plain-language message
- GIVEN an upload by U rejected with `zip_bomb`
- WHEN U views it on `/me/uploads`
- THEN a plain-language message says what happened and what to do next

### Rejected too_large upload shows a plain-language message
- GIVEN an upload by U rejected with `too_large`
- WHEN U views it on `/me/uploads`
- THEN a plain-language message says what happened and what to do next

### Rejected opted_out upload shows a plain-language message
- GIVEN an upload by U rejected with `opted_out`
- WHEN U views it on `/me/uploads`
- THEN a plain-language message says what happened and what to do next

### Duplicate upload says the work is already in the archive
- GIVEN an upload by U marked `duplicate`
- WHEN U views it on `/me/uploads`
- THEN the badge reads "Already in the archive", with a link to the work
- AND the badge does not say "Rejected", because `duplicate` is a status, not a rejection
- AND the upload is kept, not deleted

### Held upload is shown to its uploader
- GIVEN an upload by U that the versioning rules held, for a work that is live at an earlier version
- WHEN U views it on `/me/uploads`
- THEN it is listed with the badge "Held for review"
- AND V does not see it on V's `/me/uploads`

### Live upload with review reasons is still live
- GIVEN an upload by U whose version went live with review reasons
- WHEN U polls `GET /uploads/:id`
- THEN the status is `live`, not `held_for_review`
- AND the work it links to shows the notice "Chapters may be imperfect; a moderator will check."

### Failed upload shows a plain-language message
- GIVEN an upload by U that ended as `parse_failed`
- WHEN U views it on `/me/uploads`
- THEN a plain-language message says what happened and what to do next

### Messages never imply AO3 approval
- GIVEN any upload status or rejection message
- WHEN it is shown to the uploader
- THEN it never implies the archive is AO3 or approved by AO3

### My uploads requires sign-in
- GIVEN a signed-out visitor
- WHEN they open `/me/uploads`
- THEN no upload list is shown to them
- AND the response redirects them to sign in, carrying `next=/me/uploads`
