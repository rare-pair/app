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

### An empty byline goes live with byline_missing
- GIVEN an upload whose preface byline and OPF creators name nobody
- WHEN the upload is ingested
- THEN the work goes live with the review reason `byline_missing`
- AND it is listed in *Works to check* as flagged

### A byline that can only be split ambiguously goes live with byline_ambiguous
- GIVEN an upload whose byline has no profile links and reads "Salt and Pepper"
- WHEN the upload is ingested
- THEN the work goes live with the review reason `byline_ambiguous`, its authors the pieces "Salt" and "Pepper"
- AND it is listed in *Works to check* as flagged

### Each item has a detail page with actions
- GIVEN an item in the reports, takedowns or requests queue
- WHEN M opens its detail page
- THEN the page offers hide, remove, restore, approve, reject and ban uploader actions, plus block requester on a removal or opt-out request's page (a takedown's requester is free text, so its page doesn't offer it), and an open report's page offers "Dismiss report"

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
- WHEN M uses the remove action, choosing a reason where scenario 23 asks for one
- THEN W is `removed`, its R2 files and raw upload are deleted, and the sweep deletes what that delete missed, except the cases in https://github.com/rare-pair/app/issues/592
- AND its cached pages, fragments, images and download URLs are purged where the purge reaches them (what it cannot reach is in specs/scenarios/mvp/09-content-origin.md)

### A moderator dismisses a report
- GIVEN a live work W with an open report
- WHEN M uses "Dismiss report" on the report's detail page
- THEN the report is `closed` and leaves `/admin/reports`
- AND one moderation log row records `dismiss` on the report, with M's user id and the time
- AND W stays live

### Dismissing a report leaves a hidden work hidden
- GIVEN a work W the reports hid automatically, with an open report
- WHEN M dismisses the report
- THEN the report is `closed` and W stays hidden, because a dismissal lifts no hide
- AND the answer tells M that W stays hidden until restored

### Dismissing a closed report changes nothing
- GIVEN a report M has dismissed
- WHEN M dismisses it again
- THEN the answer says nothing changed, and the log still has one row for it

### A wrong-version report can't be dismissed
- GIVEN a "This version is wrong" report, or an id no report has
- WHEN M posts a dismissal for it
- THEN the response is 404 and the report stays `open`, for its own form on the work's admin page

### A report on a removed work can be dismissed
- GIVEN an open report on a removed work, which the Reports queue still lists
- WHEN M dismisses it
- THEN the report is `closed` and the work stays `removed`

### A dismissed report stops counting toward the automatic hide
- GIVEN a live work W with open reports from U and U2, and a report from U3 that M dismissed
- WHEN U2 reports W again
- THEN W stays live, because only U and U2 count
- AND when a new account U4 reports W, W is hidden automatically
- AND an account with another open report on W still counts, since the count is per account

### Rejecting a removal request leaves reports open
- GIVEN work W hidden after a removal request, with an open report
- WHEN M rejects the request
- THEN W is `live` again
- AND the report is still `open` and listed on `/admin/reports`
- AND the same holds when M reverses an opt-out or restores related works in bulk

### A moderator's restore closes reports
- GIVEN a hidden work W with an open report
- WHEN M uses the restore action on W
- THEN W is `live` again and the report is `closed`
- AND restoring a work that isn't hidden changes nothing, its open reports included

### Replacing a version leaves wrong-version reports open
- GIVEN work BV with a "This version is wrong" report
- WHEN a newer upload replaces BV's current version
- THEN the report is still `open`, so BV stays in *Works to check*

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
- AND Z's pending uploads end `account_banned`, and so do processing ones ingest has not yet saved or refused for another reason

### An account is deleted on request
- GIVEN account A that has uploaded, reported and moderated, with a session and saved reading positions
- WHEN the operator runs `scripts/account-delete.mjs` with A's address and types the address again at its prompt
- THEN it first shows what it will delete and what will stay
- AND A's account, sessions and `pos:<A's id>:` keys are gone, and nobody else's
- AND A's upload rows stay with no user attached, and A's works and versions stay public
- AND A's reports still count toward hiding a work, and the takedowns A resolved, the blocks A made and A's `moderation_actions` rows keep A's id
- AND an upload of A's that was confirmed and not yet saved is refused as a banned uploader's is, and one never confirmed is left for the reaper
- AND A's unspent sign-in links are gone, and a position A saved just before the delete, and a link made while the script waits

### Deleting an account needs confirmation
- GIVEN account A
- WHEN the operator runs the script and types anything but the address, or closes its input
- THEN nothing is deleted

### Deleting an account needs an account
- GIVEN an address no account has, or two accounts differing only in case
- WHEN the operator runs the script with it
- THEN it says so and touches nothing

### Deleting a banned account is refused
- GIVEN a banned account
- WHEN the operator runs the script with its address, or a moderator bans it while the prompt waits
- THEN the script says the ban would go with the row, and nothing is touched
- AND a ban that lands after the confirmation keeps the row, and the script says the sessions and positions are already gone

### A failed delete can be retried
- GIVEN the KV API fails partway through a delete
- WHEN the operator runs the script again
- THEN the account was still there to find, and the second run finishes

### A version whose uploader was deleted shows Deleted account
- GIVEN a work with a version whose uploader's account was deleted
- WHEN M opens the work's admin page
- THEN that version's row says "Deleted account", with no ban form
- AND the work's other versions show their uploaders as before

### Moderation works without JS
- GIVEN moderator M with JavaScript off
- WHEN M works through a queue and takes actions
- THEN every table, detail page and action works
