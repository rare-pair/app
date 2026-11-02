# Scenario: Moderation queues and actions

Relates to: docs/ARCHITECTURE.md § Data model (user.role, user.banned_at, work_versions.review_reasons, requester_blocks), § EPUB processor (Review reasons, step 7), § Author requests & takedowns (Abuse of instant hiding, Block and ban stop only the action, What hidden, held and removed works show, Moderation), § Surge controls (Status codes); docs/FRONTEND-DISCOVERY.md § Who uses it (Moderator), § Key journeys (6. Moderate), § Page inventory (Moderation queues, Work admin)

## Setup
- A signed-in moderator M (user with the moderator role)
- A signed-in user U without the moderator role, and a signed-out visitor
- Open reports, takedowns and requests created at different times
- Five removal requests from the same email and IP that hid five different works, plus one unrelated request
- An uploader Z with live uploads
- Works to check, created at different times:
  - work HV, live at v1, with a held version v2
  - work F, live with review reasons no moderator has cleared
  - work BV, with a "This version is wrong" report

## Cases

### Moderator sees four queues
- GIVEN moderator M
- WHEN M opens `/admin/reports`, `/admin/takedowns`, `/admin/requests` and `/admin/works`
- THEN each shows a plain table of its items

### Queues are oldest first
- GIVEN open items created at different times
- WHEN M opens any queue
- THEN the oldest item is listed first

### Requests queue covers removals and opt-outs
- GIVEN open `remove_work` and `opt_out` requests
- WHEN M opens `/admin/requests`
- THEN both kinds are listed

### Works to check lists held, flagged and wrong-version works
- GIVEN works HV, F and BV
- WHEN M opens `/admin/works`
- THEN HV, F and BV are each listed, oldest first

### Each item has a detail page with actions
- GIVEN an item in the reports, takedowns or requests queue
- WHEN M opens its detail page
- THEN the page offers hide, remove, restore, approve, reject, block requester and ban uploader actions

### Works to check detail page has its own actions
- GIVEN an item in *Works to check*
- WHEN M opens its detail page
- THEN the page offers approve, make version current, hide and remove

### Approving a flagged work clears the notice
- GIVEN work F in *Works to check*
- WHEN M approves it
- THEN its work and reader pages no longer show "Chapters may be imperfect; a moderator will check."
- AND F leaves *Works to check*

### Approving a held version publishes it
- GIVEN work HV in *Works to check*, live at v1 with held version v2
- WHEN M approves it
- THEN `current_version_id` points at v2 and its chapters are served
- AND HV leaves *Works to check*

### Making a version current from Works to check
- GIVEN work BV in *Works to check*, whose current version is wrong
- WHEN M uses make version current on an earlier version
- THEN `current_version_id` points at that version and its chapters are served

### Non-moderator gets 404
- GIVEN signed-in user U without the moderator role
- WHEN U opens any `/admin/` page, including `/admin/works`
- THEN the response is 404 and no queue or item is shown

### Signed-out visitor gets 404
- GIVEN a signed-out visitor
- WHEN they open any `/admin/` page
- THEN the response is 404, not a redirect to sign in, and no queue or item is shown

### Moderator hides a work
- GIVEN a live work W
- WHEN M uses the hide action
- THEN W's status is `hidden`
- AND W's pages return 451 with "Temporarily hidden by a moderator"

### Moderator restores a hidden work
- GIVEN work W hidden after a removal request
- WHEN M rejects the request and restores W
- THEN W is `live` again and readable

### Moderator removes a work
- GIVEN a work W
- WHEN M uses the remove action
- THEN W is `removed`, its R2 files and raw upload are deleted and its cached pages, fragments, images and download URLs are purged

### Related requests are listed together
- GIVEN one of the five requests from the same email and IP
- WHEN M opens its detail page
- THEN the other four requests from the same email or IP are listed on it
- AND the unrelated request is not

### Bulk restore undoes a mass-hiding spree
- GIVEN five works hidden by requests from the same email and IP
- WHEN M restores them in bulk from a request's detail page
- THEN all five works are live again

### Moderator blocks a requester
- GIVEN a request from an abusive requester
- WHEN M uses the block requester action
- THEN the requester's contact email and IP hash are blocked
- AND their later `/remove` requests, and reports from an account with that email or IP hash, are recorded and queued but hide nothing

### Moderator bans an uploader
- GIVEN uploader Z with live uploads
- WHEN M uses the ban uploader action
- THEN Z's `banned_at` is set
- AND Z can no longer upload or report
- AND Z's live works and finished uploads stay as they are until a moderator acts on them
- AND Z's pending and processing uploads end `account_banned`

### Moderation works without JS
- GIVEN moderator M with JavaScript off
- WHEN M works through a queue and takes actions
- THEN every table, detail page and action works
