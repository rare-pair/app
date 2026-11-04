# Scenario: Reports and DMCA takedown notices

Relates to: docs/ARCHITECTURE.md § Data model (reports.reporter_id, reports.kind, takedowns, requester_blocks), § Author requests & takedowns (Reports, DMCA, Block and ban stop only the action, What hidden, held and removed works show, Removal really removes, Moderation), § EPUB processor (step 4, takedown list), § Surge controls (Status codes); docs/FRONTEND-DISCOVERY.md § Key journeys (5. Report a work, 6. Moderate), § Page inventory (Report, DMCA notice, Hidden work)

## Setup
- A live work W with no open reports
- The auto-hide threshold is open reports from 3 distinct signed-in accounts, one counted per account
- `/works/:id/report` and `/dmca` are served by the web Worker
- Signed-in readers U, U2 and U3, and a signed-out reader
- A banned account Z (`banned_at` set), and a signed-in account K whose email matches a requester blocked by a moderator

## Cases

### Every work has a report button
- GIVEN live work W
- WHEN its work page renders
- THEN it has a "Report" link to `/works/:id/report`

### Signed-in reader can report a work
- GIVEN signed-in reader U on W's work page
- WHEN U follows "Report"
- THEN W's report form is shown without asking U to sign in again

### Signed-out reader is sent to sign in before reporting
- GIVEN a signed-out reader on W's work page
- WHEN they follow "Report"
- THEN they are redirected to sign in, carrying `next`, instead of seeing the report form
- AND after completing sign-in through the emailed link they are brought back to `/works/:id/report` for W using the stored `next` value

### Signed-out report submission redirects to sign in
- GIVEN a signed-out reader with no session cookie
- WHEN they POST a report for W to `/works/:id/report`
- THEN no `reports` row is stored
- AND the response redirects them to sign in, carrying `next=/works/:id/report`

### Report form asks for a reason and optional details
- GIVEN signed-in reader U on `/works/:id/report`
- WHEN the form renders
- THEN it asks for a reason, one of which is "This version is wrong", and optional details
- AND it works with JavaScript off

### Submitting a report stores it and confirms
- GIVEN signed-in reader U on W's report form
- WHEN U submits a reason
- THEN an open `reports` row is stored for W with `reporter_id` set to U
- AND a confirmation page explains what happens next

### Report without details is accepted
- GIVEN signed-in reader U on W's report form
- WHEN U submits a reason and leaves details empty
- THEN the report is stored with `reporter_id` set to U

### This version is wrong queues the work in Works to check
- GIVEN signed-in reader U on W's report form
- WHEN U submits the reason "This version is wrong"
- THEN a `wrong_version` report is stored for W
- AND W is listed in the moderators' *Works to check* queue

### This version is wrong reports never count toward hiding
- GIVEN work W with open reports from U and U2
- WHEN U3 submits a report for W with the reason "This version is wrong"
- THEN the `wrong_version` report is stored and W is listed in *Works to check*
- AND W stays live, because `wrong_version` reports never count toward the 3-account auto-hide

### Reports from two accounts keep the work live
- GIVEN work W with open reports from U and U2
- WHEN a moderator has not yet acted
- THEN W stays live

### Report from a third account hides the work automatically
- GIVEN work W with open reports from U and U2
- WHEN U3 submits a report for W
- THEN W is hidden automatically until a moderator looks at it
- AND W's pages return 451 with "Temporarily hidden after reader reports"

### Repeat reports from one account count once
- GIVEN work W with open reports from U and U2
- WHEN U submits two more reports for W
- THEN the reports are stored but count once for U
- AND W stays live

### Banned account cannot report
- GIVEN banned account Z
- WHEN Z submits a report for W
- THEN no `reports` row is stored

### Reports matching a blocked requester do not count toward hiding
- GIVEN work W with open reports from U and U2
- WHEN account K, whose email matches a blocked requester, submits a report for W
- THEN the report is stored and queued for a moderator
- AND W stays live

### DMCA form is public
- GIVEN any visitor
- WHEN they open `/dmca`
- THEN a statutory takedown notice form is shown
- AND it opens, and a notice posted from it is kept, for a signed-in account that has not accepted the terms (the terms gate exempts `/dmca`, as it does `/remove`)
- AND it needs JavaScript, for its Turnstile check: without it the page shows a `<noscript>` message that names the notices address and what a notice must say, and no notice can be submitted

### Submitting a DMCA notice creates a takedown
- GIVEN a visitor on `/dmca`
- WHEN they submit a notice naming work W
- THEN a `takedowns` row is stored for W
- AND it appears in the moderators' takedowns queue
- AND W stays live until a moderator decides, unlike a `/remove` request

### A DMCA notice needs a passing Turnstile check
- GIVEN a visitor on `/dmca`
- WHEN they submit a notice naming work W with no Turnstile token, a token solved on another form, or while Turnstile cannot be reached
- THEN no `takedowns` row is stored and the form says the anti-spam check did not pass, or is not answering
- AND every field and both checkboxes come back as typed, with a fresh Turnstile widget
- AND the per-IP limit is counted before the check, so a post over the limit is refused with 429 (with `Retry-After`) whatever its token, and that page also keeps every field, shows a fresh widget and names the notices address
- AND each of these refusals names the notices address, so a visitor whose check is blocked can still email a notice

### Incomplete DMCA notice is noted in the queue
- GIVEN a visitor on `/dmca`
- WHEN they submit a notice naming work W but missing some statutory elements
- THEN a `takedowns` row is stored for W and appears in the takedowns queue marked incomplete
- AND W stays live

### Moderator hides a work after a DMCA notice
- GIVEN a takedown on work W
- WHEN a moderator decides to hide W
- THEN W is hidden and its pages return 451 with "Temporarily hidden by a moderator"

### Takedown approval removes the work
- GIVEN a takedown on work W
- WHEN a moderator approves it and W is set to `removed`
- THEN `works/<ao3_work_id>/` and the raw upload are deleted from R2, and the sweep deletes what that delete missed, except the cases in https://github.com/rare-pair/app/issues/592
- AND the work's cached pages, fragments, images and download URLs are purged where the purge reaches them (what it cannot reach is in specs/scenarios/mvp/09-content-origin.md)
- AND W's page returns 410
- AND W's AO3 work ID goes on the takedown list

### Taken-down work cannot be re-uploaded
- GIVEN a DMCA notice on the work with AO3 work ID 12345, after which a moderator removed the work, so 12345 is on the takedown list
- WHEN a new epub of work 12345 is ingested
- THEN it is rejected with `opted_out`

### Pending DMCA notice does not block an upload
- GIVEN a DMCA notice on the work with AO3 work ID 12345 that no moderator has acted on yet
- WHEN a new epub of work 12345 is ingested
- THEN it is not rejected with `opted_out`
- AND it goes through the normal versioning rules
