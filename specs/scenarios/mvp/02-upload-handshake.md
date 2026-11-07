# Scenario: Upload request, transfer through the Worker, and confirm

Relates to: docs/ARCHITECTURE.md § Ingestion pipeline (steps 1-3), § Dedupe, § Surge controls (Status codes, Orphaned uploads); docs/FRONTEND-DISCOVERY.md § Key journeys (3. Upload works), § Where the frontend changes the architecture (1. Forms with Turnstile need JS), § Page inventory (Upload)

## Setup
- A signed-in user U with an active session and remaining daily upload quota
- Turnstile is configured on upload requests; passing and failing test tokens are available
- R2 bucket with an `uploads/` prefix and a lifecycle rule expiring `uploads/` objects after 7 days, bound to the web Worker
- The ingest queue is observable so enqueued `{upload_id}` messages can be asserted
- Fixture epubs: a valid AO3 export, one of exactly 25 MB, and one just over 25 MB
- A live work W whose stored upload has SHA-256 H

## Cases

### Upload request makes an upload and returns its id
- GIVEN user U with a passing Turnstile token and remaining quota
- WHEN U calls `POST /uploads` declaring a size of 25 MB or less
- THEN an `uploads` row is inserted for U
- AND the response contains its id, and no link to the bucket

### Declared size of exactly 25 MB is accepted
- GIVEN user U with a passing Turnstile token and remaining quota
- WHEN U calls `POST /uploads` declaring exactly 25 MB
- THEN the upload's id is returned

### Declared size over 25 MB is refused
- GIVEN user U with a passing Turnstile token and remaining quota
- WHEN U calls `POST /uploads` declaring a size over 25 MB
- THEN the response is 413, with no `uploads` row inserted
- AND the upload page says the file is over the 25 MB limit

### Upload request without a session is refused
- GIVEN a visitor with no session
- WHEN their browser's script calls `POST /uploads`
- THEN the response is 401, not a redirect
- AND no `uploads` row is inserted

### Upload request without Turnstile is refused
- GIVEN user U
- WHEN U calls `POST /uploads` with a missing or failing Turnstile token
- THEN the response is 400, with no `uploads` row inserted
- AND the upload page shows the error

### Upload request over the daily quota is refused
- GIVEN user U who has used all of today's upload quota (the uploads U has confirmed; see scenario 19)
- WHEN U calls `POST /uploads`
- THEN the response is 429 with a `Retry-After` header, with no `uploads` row inserted
- AND the upload page says when U can upload again

### The Worker streams a sent file to R2
- GIVEN an open upload of U's, as `POST /uploads` left it
- WHEN U's browser PUTs a file of the declared size to `/uploads/:id`, with `Content-Type: application/epub+zip`
- THEN the response is 200, and the object at `uploads/<id>` holds those bytes
- AND the upload stays `pending` and uncounted, until it is confirmed

### A file of exactly 25 MiB is stored
- GIVEN an open upload declaring exactly 25 MiB
- WHEN a file of that size is sent to it
- THEN it is stored, whole

### A sent file without a session is refused
- GIVEN an open upload
- WHEN a request with no session PUTs a file to it
- THEN the response is 401, not a redirect, and nothing is stored

### A sent file from another site is refused
- GIVEN an open upload of U's
- WHEN a page on another site PUTs a file to it with U's cookie
- THEN the response is 403, before any session lookup, and nothing is stored

### A sent file for another user's upload and for an unknown one are refused alike
- GIVEN an upload of another user's, and an id no upload has
- WHEN U PUTs a file to each
- THEN both answers are the same 404, nothing is stored, and the other user's upload stays

### A sent file from a banned account is refused and stores nothing
- GIVEN an open upload of an account banned since it was made, whose ban didn't reach it
- WHEN a file is sent to it
- THEN the response is 403, nothing is stored, and the upload ends `account_banned`

### Of two sends at once, the one that finishes second stores nothing
- GIVEN two files on their way to one open upload
- WHEN one is stored while the other is still arriving
- THEN the other gets 409, and the first file and the row are untouched

### A sent file for an upload a ban has ended stores nothing
- GIVEN an upload a ban has ended as `account_banned`
- WHEN a file is sent to it
- THEN it is refused and nothing is stored

### A sent file with another content type is refused and frees its slot
- GIVEN an open upload
- WHEN a file is sent to it with a `Content-Type` other than exactly `application/epub+zip` or `application/pdf` (specs/scenarios/mvp/12-pdf-upload.md)
- THEN the response is 415, nothing is stored, and the upload's row is deleted

### A sent file with no Content-Length is refused and frees its slot
- GIVEN an open upload
- WHEN a file is sent to it with no `Content-Length`
- THEN the response is 411, nothing is stored, and the upload's row is deleted

### A Content-Length that isn't a whole number is refused and frees its slot
- GIVEN an open upload
- WHEN a file is sent with a `Content-Length` of `abc`, `-1`, `1e1` or nothing
- THEN the response is 411, nothing is stored, and the upload's row is deleted

### An account that hasn't accepted the terms gets a 401 it can act on
- GIVEN an account that hasn't accepted the terms
- WHEN its script calls `PUT` or `DELETE /uploads/:id`
- THEN the response is a JSON 401, not a redirect, and any row it holds is the reaper's

### A sent file whose Content-Length differs from the size declared is refused and frees its slot
- GIVEN an open upload
- WHEN a file is sent with a `Content-Length` of any other size than was declared
- THEN the response is 400, nothing is stored, and the upload's row is deleted

### A sent file declaring over 25 MB is refused before a byte is read, and frees its slot
- GIVEN an open upload, on an account at the cap on open uploads
- WHEN a file is sent with a `Content-Length` over 25 MB
- THEN the response is 413 with no byte read, nothing is stored, and the upload's row is deleted
- AND the account can ask for another upload

### A body longer or shorter than its Content-Length stores nothing and frees its slot
- GIVEN an open upload, on an account at the cap on open uploads
- WHEN a body that doesn't match its `Content-Length` is sent to it
- THEN the Worker's own count, as the bytes arrive, fails it: nothing is stored and the upload's row is deleted
- AND the account can ask for another upload

### A dropped upload stores nothing and frees its slot
- GIVEN an open upload, on an account at the cap on open uploads
- WHEN the connection is lost part way through its file, and the Worker sees that
- THEN nothing is stored and the upload's row is deleted
- AND the account can ask for another upload

### A store that R2 refuses frees the slot
- GIVEN an open upload
- WHEN R2 fails the write
- THEN the response is JSON with a message to upload the file again, and the upload's row is deleted

### A second file sent to an open upload stores nothing, and the first stays
- GIVEN an open upload whose file has arrived, not yet confirmed
- WHEN another file is sent to it
- THEN the response is 409, and the first file and the row are untouched

### A second file is refused before its body is read, whatever its headers
- GIVEN an open upload whose file has arrived
- WHEN another send arrives, well formed or not
- THEN the response is 409 with no byte read, so repeats cost a lookup and no more
- AND a send that was already under way when the first finished can't store (the write is create-only), and if it fails it ends the upload like any failed send, first file included: it can only come from the uploader, who is told to upload again

### A file sent to an upload that has ended stores nothing
- GIVEN an upload that is `duplicate`, `too_large`, `over_quota`, `processing` or `live`, or that a confirm has counted
- WHEN a file is sent to it
- THEN the response is 409 and nothing is stored

### An upload removed while its file arrives keeps no object
- GIVEN a file on its way to an open upload
- WHEN the reaper, or a confirm that found no file, removes the row before the last byte
- THEN the response is 409 and no object is left

### An upload a ban ends while its file arrives keeps no object
- GIVEN a file on its way to an open upload
- WHEN a ban ends the upload before the last byte
- THEN the response is 409, no object is left, and the upload stays `account_banned`

### An upload a confirm counts as its file finishes keeps its object for ingest
- GIVEN a file just finishing on its way to an open upload
- WHEN a confirm counts the upload before the Worker looks at the row again
- THEN the object stays, for ingest to read

### A slow file that arrives after ingest has finished its upload keeps no object
- GIVEN a file still arriving for an upload that has since gone `live`, with no object left at its key
- WHEN it finishes, and the create-only write finds nothing there
- THEN the response is 409 and no object is left, since nothing will read it
- AND where the first file is still at its key, the write stores nothing and that file stays for the 7-day rule

### Whether real R2 does all this is checked after deploy
- GIVEN the web Worker deployed on real R2, none of which a local test can show
- WHEN the operator runs the post-deploy check
- THEN a 25 MB epub sent through `PUT /uploads/:id` is stored whole, at exactly its size
- AND a body one byte over or under its declared size stores nothing and frees the row (send it with a client that lets the length lie, or by a raw connection, since the edge may refuse it first)
- AND a connection dropped part way leaves no object, and the row deleted or, if the Worker never heard, taken by the reaper within two days. Cloudflare's docs warn that a write whose outcome is unknown may still commit after a read finds nothing, so look for the object again a minute later
- AND a second PUT to an open upload whose file has arrived gets 409, with the first file intact (`If-None-Match: *` through the binding)
- AND several 25 MB PUTs at once stay within the Worker's memory and CPU limits
- AND Cloudflare's WAF and Bot Fight Mode let a 25 MB same-site PUT, and the page's DELETE, through
- AND the clean-up of a dropped connection runs: `waitUntil` carries it past the client's going, for a bounded time
- AND this case is on the operator's review list, not shown by any local test

### Browser with JS sends a file through the Worker with progress
- GIVEN user U on `/upload` with JavaScript on
- WHEN U picks an epub and submits
- THEN the browser PUTs the file to `/uploads/:id` on this site
- AND the page shows upload progress

### Upload of several files in one go
- GIVEN user U on `/upload` with JavaScript on and quota for at least three uploads
- WHEN U picks three epub files and submits
- THEN each file gets its own `uploads` row
- AND each file is PUT to its own address, with its own progress
- AND each finished transfer goes through `POST /uploads/:id/complete`

### Picked and dropped files wait in a list until Upload
- GIVEN user U on `/upload` with JavaScript on
- WHEN U picks epub files with the file picker, or drops them on the marked drop area
- THEN each shows in a list with its name and size, and nothing is sent
- AND the file picker is still there for keyboard, screen reader and phone users
- AND the page announces how many files were added

### Adding more files adds to the list, and a file added twice shows once
- GIVEN a list of files
- WHEN U adds more files, one of them a file already in the list
- THEN the list holds the earlier files and the new ones, and the repeat shows once
- AND the page announces that it was already in the list

### A row can be removed, and focus lands next to it
- GIVEN a list of files
- WHEN U presses a row's Remove button
- THEN the row goes, the page announces it, and nothing is sent
- AND focus lands on the Remove button of the row that took its place, or the one before it, or the file picker when the list is empty

### A file that cannot be sent says so in the list
- GIVEN a list holding a file that is not an epub, an empty file and a file over the size limit
- WHEN the files are added
- THEN each row shows its problem
- AND U presses Upload, and those files are not sent
- AND the other files in the list are

### A long list is sent in groups of 10
- GIVEN a list of 25 files that can be sent
- WHEN U presses Upload
- THEN the page asks `POST /uploads` for the first 10, sends them and confirms all 10
- AND only then gets a fresh Turnstile token, with no click, and asks for the next 10, and then the last 5
- AND no `POST /uploads` asks for more than 10 files

### A Turnstile check that needs the person is said aloud
- GIVEN a long list, partway through the groups
- WHEN the fresh Turnstile check asks the person to do something
- THEN the page says so, and goes on once the check passes

### A daily quota that runs out partway keeps what was sent
- GIVEN a list of 15 files and quota for 12
- WHEN the second group is refused for the quota
- THEN the first 10 stay sent, and show as uploaded
- AND the rows of the refused group say they were not uploaded and stay in the list
- AND pressing Upload again, once the quota allows, sends only those
- AND a group refused whole stays whole: the server counts the group's files against the quota together

### A rate limit that clears within a minute is waited out
- GIVEN a long list, and a group's ask refused 429 with a `retryAfter` of the rate-limit window
- WHEN the page gets that answer
- THEN it says it is pausing, waits, gets a fresh Turnstile token and asks for the same group again
- AND a 429 that clears much later, such as a spent quota, isn't waited out

### A transfer answered 409 goes on to the confirm and isn't reported
- GIVEN a PUT answered 409, such as a stored file's PUT sent again by the browser after its answer was lost
- WHEN the page gets that answer
- THEN it confirms the upload, which says what became of it, and reports nothing

### A failed upload the page reports frees its slot
- GIVEN an open upload, on an account at the cap on open uploads
- WHEN the page's PUT fails, stalls and is ended, or its confirm never reaches the server, and the page calls `DELETE /uploads/:id`
- THEN the upload's row and any object go
- AND the account can ask for another upload, and another click sends the file
- AND a closed tab reports nothing, so that upload is the reaper's

### Reporting frees only the caller's own open upload
- GIVEN an upload of another user's, one a confirm has counted, and one that has ended
- WHEN U calls `DELETE /uploads/:id` on each
- THEN each is answered 404, and each row and object stays
- AND without a session the answer is 401, and from another site 403

### Upload page without JavaScript explains it is needed
- GIVEN user U with JavaScript off
- WHEN U opens `/upload`
- THEN the page shows a `<noscript>` message saying uploading needs JavaScript
- AND no file can be uploaded from the page

### Confirm enqueues the upload
- GIVEN an upload whose object is in R2 and is 25 MB or less
- AND no stored upload has the same SHA-256
- WHEN `POST /uploads/:id/complete` is called
- THEN the Worker reads the object, checks its size and hashes it
- AND a `{upload_id}` message is put on the ingest queue

### Confirm marks a byte-identical re-upload as duplicate
- GIVEN an upload whose object in R2 has SHA-256 H, the same as an earlier upload that was ingested into live work W
- WHEN `POST /uploads/:id/complete` is called
- THEN the upload is marked `duplicate` straight away, with its `work_id` set to W
- AND nothing is put on the ingest queue and no ingest run happens
- AND the object is not copied to `originals/`, so no second copy is kept
- AND the uploader sees the "Already in the archive" badge with a link to W

### Hash match on an upload still being processed gets no shortcut
- GIVEN an earlier upload with SHA-256 H that is still `pending` or `processing`, with no work yet
- WHEN a new upload with the same hash H is confirmed
- THEN it is enqueued like any other upload, not marked `duplicate` at confirm
- AND once both are processed, the versioning rules mark the later one `duplicate`

### Hash match on a rejected upload gets no shortcut
- GIVEN an earlier upload with SHA-256 H that was rejected (for example `not_ao3`), so it has no work
- WHEN a new upload with the same hash H is confirmed
- THEN it is enqueued and processed like any other upload
- AND it ends with the same rejection code, not as `duplicate`

### Hash match on a removed work gets no shortcut
- GIVEN an earlier upload with SHA-256 H whose work was removed
- WHEN a new upload with the same hash H is confirmed
- THEN it is enqueued and processed, and the takedown or opt-out checks decide it

### Confirm is never called
- GIVEN an object PUT to `uploads/` whose client never calls `/complete`
- WHEN 7 days have passed since the object was written
- THEN the R2 lifecycle rule has expired the object, if the reaper hasn't already deleted it

### Confirm refuses a stored file of another size than declared and frees its slot
- GIVEN an upload whose stored object is larger or smaller than its declared size, or over 25 MB (`PUT /uploads/:id` stores no such thing, so this is a defence against R2 breaking its promises to that route)
- WHEN `POST /uploads/:id/complete` is called
- THEN the response is 400 with a plain message, and the object and the upload's row are deleted
- AND nothing is counted against the quota and nothing is put on the ingest queue

### An upload whose object never arrived is refused and frees its slot
- GIVEN an open upload with no object
- WHEN `POST /uploads/:id/complete` is called
- THEN the response is 400 with a plain message, and the upload's row is deleted

### A confirm that can't reach the queue frees the slot and gives back the use
- GIVEN an upload whose confirm has just counted it
- WHEN the queue refuses the message
- THEN the response is 503, saying to upload the file again in a minute
- AND the object and the upload's row are deleted, and the use of the quota is given back

### A confirm that faults frees the slot
- GIVEN an open upload
- WHEN a fault in R2 or the database ends its confirm
- THEN the response is 500, and the object and the upload's row are deleted, if the fault lets them be

### A confirmed upload's object is left alone by a repeat confirm of another size
- GIVEN an upload a confirm has counted and queued, whose object has since been replaced by one of another size (nothing on the site can do this now)
- WHEN `POST /uploads/:id/complete` is called again
- THEN the response is 409, and the object stays for ingest to read

### A confirmed upload's object is left alone by a repeat confirm of an oversized file
- GIVEN an upload a confirm has counted and queued, whose object has since been replaced by one over 25 MB (nothing on the site can do this now)
- WHEN `POST /uploads/:id/complete` is called again
- THEN the response is 409, the upload stays `pending` and the object stays for ingest to read and refuse

### Confirming an upload the reaper has removed answers as an unknown one
- GIVEN an unconfirmed upload the reaper, or a failure, has removed
- WHEN its browser tab, resumed later, calls `POST /uploads/:id/complete`
- THEN the response is 404

### A repeat confirm that can't reach the queue leaves the upload confirmed
- GIVEN an upload a confirm has counted and queued
- WHEN `POST /uploads/:id/complete` is called again and the queue refuses the message
- THEN the response is 503, and the upload stays counted, so the reaper never takes it

### Asking for uploads beyond the cap on open uploads is refused
- GIVEN user U whose open uploads (`pending` and not yet counted by a confirm) would pass the cap, which is U's daily quota for U's tier, with the files asked for
- WHEN U calls `POST /uploads`
- THEN the response is 429 with `Retry-After: 3600`, with no `uploads` row inserted
- AND the upload page shows a plain message saying how many more U can start, that unfinished uploads clear by themselves, and to try again then

### A batch that fits under the cap works, and one past it is refused whole
- GIVEN user U two uploads short of the cap on open uploads
- WHEN U asks for three, and then for two
- THEN the three are refused with no row inserted, and the two get their rows

### A full batch of 10 files still works under the cap
- GIVEN user U with 10 open uploads, on the new-account daily quota of 100
- WHEN U asks for 10 more
- THEN each file gets its own `uploads` row

### The cap is the account's daily quota for its tier
- GIVEN trusted user T with open uploads past the new-account limit, and under the trusted one (the tiers are both 100 in wrangler.jsonc for now, so the test sets a lower new-account tier)
- WHEN T asks for one more
- THEN T gets an upload, and once T is at the trusted limit T is refused

### Only the account's own unconfirmed uploads are open
- GIVEN user U one short of the cap, with confirmed, processing and rejected uploads besides, and another user's open uploads
- WHEN U asks for one more
- THEN U gets an upload

### An unconfirmed upload older than a day is removed, with any file
- GIVEN an upload that is `pending`, not counted by a confirm, and created longer ago than the configured age of 1 day
- WHEN the daily sweep runs
- THEN the row is deleted, and its object if it has one
- AND nothing under `works/` or `originals/` is touched for it

### A run removes a bounded number of uploads, and the next run takes the rest
- GIVEN more stale unconfirmed uploads than one run's reaper may remove
- WHEN the daily sweep runs
- THEN it removes that many, with their files, and the next run removes the others

### An unconfirmed upload removed as stale no longer shows on My uploads
- GIVEN an unconfirmed upload that has been removed as stale
- WHEN its uploader opens `/me/uploads`
- THEN it isn't listed, and their newer unconfirmed uploads still are

### An unconfirmed upload not yet a day old stays
- GIVEN an unconfirmed upload created exactly the configured age before the run
- WHEN the daily sweep runs
- THEN the row and its object stay

### A confirmed upload is never removed, whatever its age
- GIVEN an upload of any age that a confirm has counted, or that is `processing`, `live`, `held_for_review`, `duplicate` or rejected
- WHEN the daily sweep runs
- THEN the row and its object stay

### Upload requests are rate-limited
- GIVEN user U, or U's IP address, has reached the upload-request rate limit in the current window
- WHEN U calls `POST /uploads` again
- THEN the response is 429 with a `Retry-After` header and no `uploads` row is inserted
- AND the PUT and DELETE routes spend no rate limit: each file was counted here, its upload stores one file, and a repeat is refused before its body is read
