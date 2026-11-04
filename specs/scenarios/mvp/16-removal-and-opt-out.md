# Scenario: Remove-my-work and opt-out requests

Relates to: docs/ARCHITECTURE.md § Decisions so far (Author identity), § Data model (requests, optouts, requester_blocks), § Dedupe (Pseuds), § Author requests & takedowns, § Surge controls (Status codes); docs/FRONTEND-DISCOVERY.md § Key journeys (4. Remove a work or opt out), § Page inventory (Remove my work / opt out, Hidden work), § Where the frontend changes the architecture (1. Forms with Turnstile need JS)

## Setup
- Live work W at `/works/:id` with AO3 URL `archiveofourown.org/works/12345`, by pseud P, written `Moon Child`
- Live works W2 and W3 also by pseud P, and work X by another pseud
- No work in the archive has AO3 URL `archiveofourown.org/works/99999`
- Turnstile is configured on `/remove`; rate limits apply per email and per IP
- `pseud_norm` is the pseud in Unicode NFKC, case-folded, with leading and trailing whitespace trimmed and inner runs of whitespace collapsed to one space; punctuation is kept
- A requester B blocked by a moderator, by contact email and IP hash
- The visitor is signed out

## Cases

### Form needs no sign-in
- GIVEN a signed-out visitor with JavaScript on
- WHEN they open `/remove`
- THEN the request form is shown without asking them to sign in

### Removal form without JavaScript explains it is needed and gives the moderators' contact address
- GIVEN a signed-out visitor with JavaScript off
- WHEN they open `/remove`
- THEN the page shows a `<noscript>` message saying the request form needs JavaScript
- AND the message gives the moderators' contact address
- AND no request can be submitted from the page

### Footer link reaches the form
- GIVEN any page
- WHEN a visitor follows "Remove my work" in the footer
- THEN they reach `/remove`

### Work is prefilled from the work page
- GIVEN a visitor on W's work page
- WHEN they follow "Ask for this to be removed"
- THEN `/remove?work=:id` shows the form with W prefilled

### Form says there is no proof of identity
- GIVEN the `/remove` form
- WHEN it renders
- THEN it says plainly that no proof of identity is asked for, because there is nothing to check against while AO3 is down

### Remove request by the work's URL here hides it once confirmed
- GIVEN live work W
- WHEN a visitor submits `/remove` with W's URL on this site, a contact email, a short statement and a passing Turnstile token
- THEN a `remove_work` request is stored, unconfirmed, and W stays live
- AND one confirmation email with a single-use link goes to the contact email through the mailer queue
- WHEN the requester opens the link and presses its button
- THEN the request is confirmed, W is hidden and its `request_works` row is written
- AND the request awaits moderator review

### Remove request by AO3 URL hides it once confirmed
- GIVEN live work W
- WHEN a visitor submits `/remove` with `archiveofourown.org/works/12345`, a contact email, a statement and a passing Turnstile token, then confirms it by the emailed link
- THEN W is hidden once the link is confirmed, and not before

### Remove request for an AO3 work not in the archive stores nothing
- GIVEN no work in the archive with AO3 URL `archiveofourown.org/works/99999`
- WHEN a visitor submits `/remove` with that URL, a contact email, a statement and a passing Turnstile token
- THEN no request is stored, no email is sent and nothing is hidden
- AND the confirmation page says the work isn't in the archive and suggests opting out the pseud instead

### Confirmation page for a work
- GIVEN a remove request for W just submitted by a requester who isn't blocked
- WHEN the confirmation page renders
- THEN it says "Check your email: we've sent a link to the address you gave. Open it and press the button to confirm your request. The link works once, for 7 days, and nothing happens until you confirm."
- AND it says nothing about whether the work is hidden, so it reads the same as a blocked requester's

### Confirmation link opens a page with a button and changes nothing
- GIVEN an unconfirmed request and its emailed link
- WHEN anything opens the link with a GET, as a mail scanner does
- THEN the page shows only a Confirm button that posts the token, and the request stays unconfirmed
- AND nothing is hidden

### A confirmation link works once and expires
- GIVEN an emailed confirmation link
- WHEN it is used a second time, or more than 7 days after the email was sent, or its request was rejected by a moderator, or its token was never issued
- THEN one page says the link has been used or has expired, or was never valid
- AND nothing is hidden or written, and a press from another site is refused

### Confirmation answers are the same whatever the work's status
- GIVEN requests for a live work, a hidden work and a removed work
- WHEN each is submitted and then confirmed
- THEN the submit pages are identical, the emails differ only by their token, and the confirmed pages are identical
- AND none says whether the work is live, hidden or removed

### Moderators see unconfirmed requests, marked
- GIVEN a request whose requester has not confirmed it
- WHEN a moderator opens the requests queue or the request
- THEN it is listed as pending and marked unconfirmed
- AND a confirmed request carries no mark

### Approve needs a confirmed request
- GIVEN a pending removal request or opt-out whose requester has not confirmed it
- WHEN a moderator opens it, or posts its approve
- THEN no Approve form is offered, only Reject, and the post is refused with the item left unchanged
- AND the related-requests table marks it unconfirmed too

### An unconfirmed opt-out blocks nothing at ingest
- GIVEN an opt-out for pseud P that is not confirmed
- WHEN an upload by P is ingested
- THEN it is not rejected with `opted_out`, because no active `optouts` row exists until the requester confirms

### Hidden work shows a temporary-hide page
- GIVEN W hidden after a removal request
- WHEN anyone opens W's work page, any of its chapter URLs or `/works/:id/full`
- THEN the response is 451 with "Temporarily hidden after a removal request", not a 404
- AND W is left out of search, listings and the home page

### Opt-out hides use the removal-request wording
- GIVEN W2 hidden by an opt-out for pseud P
- WHEN anyone opens W2
- THEN the response is 451 with "Temporarily hidden after a removal request", because opt-outs come through `/remove`

### Opt-out by pseud hides every existing work once confirmed
- GIVEN works W, W2 and W3 by pseud P and work X by another pseud
- WHEN a visitor submits `/remove` with pseud P instead of a work, a contact email, a statement and a passing Turnstile token
- THEN an `opt_out` request is stored, unconfirmed, with no `optouts` row, and W, W2 and W3 stay live
- AND one confirmation email with a single-use link goes to the contact email
- WHEN the requester opens the link and presses its button
- THEN an active `optouts` row for P's `pseud_norm` is stored
- AND W, W2 and W3 are hidden and their `request_works` rows are written
- AND X is unaffected

### Confirmation page for an opt-out
- GIVEN an opt-out for pseud P just submitted by a requester who isn't blocked
- WHEN the confirmation page renders
- THEN it says "Check your email: we've sent a link to the address you gave. Open it and press the button to confirm your request. The link works once, for 7 days, and nothing happens until you confirm."
- AND it says nothing about whether any work is hidden, so it reads the same as a blocked requester's

### Opt-out blocks future uploads
- GIVEN an active opt-out for pseud P
- WHEN a new AO3 epub by P is uploaded
- THEN it is rejected at ingest with `opted_out`

### Opt-out matches the normalized pseud
- GIVEN an active opt-out for pseud P
- AND an upload whose byline pseud has the same `pseud_norm` as P under the NFKC, case-fold, trim and collapse-whitespace rule
- WHEN the upload is ingested
- THEN it is rejected with `opted_out`

### Opt-out matches a pseud that differs only in case
- GIVEN an active opt-out requested for `Moon Child`
- WHEN an upload whose byline pseud is `moon CHILD` is ingested
- THEN it is rejected with `opted_out`

### Opt-out matches a pseud with extra spaces
- GIVEN an active opt-out requested for `Moon Child`
- WHEN an upload whose byline pseud is `  Moon   Child ` is ingested
- THEN it is rejected with `opted_out`

### Opt-out does not match different punctuation
- GIVEN an active opt-out requested for `Moon Child`
- WHEN an upload whose byline pseud is `Moon_Child` is ingested
- THEN it is not rejected with `opted_out`, because punctuation is kept in `pseud_norm`

### Opt-out checks the OPF creator when the preface byline is blank
- GIVEN an active opt-out for pseud P
- AND an upload whose preface byline names nobody (a link whose text is a space or a zero-width character) and whose OPF `dc:creator` is P
- WHEN the upload is ingested
- THEN it is rejected with `opted_out`

### Opt-out checks an OPF creator the preface byline doesn't name
- GIVEN an active opt-out for pseud P
- AND an upload whose preface byline names Q and whose OPF `dc:creator` entries are Q and P
- WHEN the upload is ingested
- THEN it is rejected with `opted_out`

### Opt-out checks every name of a byline with no profile links
- GIVEN an active opt-out for pseud P
- AND an upload whose byline has no profile links and reads "Q and P"
- WHEN the upload is ingested
- THEN it is rejected with `opted_out`

### A file the lists refuse is recorded, not retried
- GIVEN an upload whose byline holds a value the opt-out table can't take (a NUL byte)
- WHEN the upload is ingested
- THEN it ends `parse_failed` with a fixed error code at the process stage, and is acknowledged
- AND nothing is saved
- AND a failure to read the lists at all is still retried

### A long byline is checked in one query
- GIVEN an active opt-out for the last of 70,000 pseuds in a byline
- WHEN the upload is ingested
- THEN it is rejected with `opted_out`

### An AO3 work ID that is not a work key is refused
- GIVEN an upload whose AO3 work ID is `0`, has a leading zero (`041520`) or is past int4
- WHEN the upload is ingested
- THEN it ends `parse_failed` with `bad_work_id`
- AND a takedown of work 41520 does not reject the file with the ID `041520`

### Moderator approves an opt-out
- GIVEN a pending opt-out request for P that its requester has confirmed
- WHEN a moderator approves it
- THEN the opt-out stays active and P's works stay hidden

### Mistaken opt-out can be reversed
- GIVEN an active opt-out for P that was made by mistake
- WHEN a moderator reverses it
- THEN the opt-out is no longer active
- AND new uploads by P are no longer rejected with `opted_out`

### Missing Turnstile is refused
- GIVEN the `/remove` form
- WHEN it is submitted with a missing or failing Turnstile token
- THEN the response is 400 and shows the form again with an error
- AND no request is stored and nothing is hidden

### Missing fields are refused
- GIVEN the `/remove` form
- WHEN it is submitted without a contact email or without a work or pseud
- THEN the response is 400 and shows the form again with the missing fields marked as errors
- AND no request is stored and nothing is hidden

### Requests are rate-limited per email
- GIVEN one contact email that has reached the request rate limit
- WHEN another request is submitted with that email from a different IP
- THEN the response is 429 with a `Retry-After` header and a plain page saying when to try again
- AND no request is stored and nothing more is hidden

### Requests are rate-limited per IP
- GIVEN one IP address that has reached the request rate limit
- WHEN another request is submitted from that IP with a different email
- THEN the response is 429 with a `Retry-After` header and a plain page saying when to try again
- AND no request is stored and nothing more is hidden

### Blocked requester's requests only queue
- GIVEN requester B, blocked by contact email and IP hash
- WHEN a request to remove live work X arrives from B's email, or from B's IP with another email, with a passing Turnstile token
- THEN the request is stored and appears in the moderators' requests queue
- AND X stays live

### Blocked requester's opt-out hides nothing
- GIVEN requester B, blocked by contact email and IP hash
- WHEN B submits an opt-out for pseud P
- THEN the request is stored and queued for a moderator
- AND W, W2 and W3 stay live
- AND no active `optouts` row is created unless a moderator approves the request

### Blocked requester sees the same confirmation
- GIVEN requester B, blocked by contact email and IP hash
- WHEN B submits a request to remove live work X, or an opt-out for pseud P, with a passing Turnstile token
- THEN the confirmation page is identical to an unblocked requester's: "Check your email: we've sent a link to the address you gave. Open it and press the button to confirm your request. The link works once, for 7 days, and nothing happens until you confirm."
- AND nothing on the page reveals that B is blocked

### Requests record a hashed IP
- GIVEN any submitted request
- WHEN it is stored
- THEN the row has an `ip_hash`, not the raw IP

### Approved removal really removes
- GIVEN work W hidden after a removal request
- WHEN a moderator approves the request and the work is set to `removed`
- THEN `works/<ao3_work_id>/` and the raw upload are deleted from R2, and the sweep deletes what that delete missed, except the cases in https://github.com/rare-pair/app/issues/592
- AND the work's pages, cached fragments, images and download URLs are purged from the cache where the purge reaches them (what it cannot reach is in specs/scenarios/mvp/09-content-origin.md)
- AND W's page returns 410 "This work has been removed"

### Authors update works the same way as anyone
- GIVEN an author who wants to update their work
- WHEN they look for a way to do it
- THEN there is no claim, author account or "my works" page, only a normal upload under the versioning rules
