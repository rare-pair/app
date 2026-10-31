# Scenario: Coming-soon page and launch wait list

Relates to: docs/ARCHITECTURE.md § Decisions so far (Wait list), § Wait list, § Auth (Email), § Surge controls, § Data model; docs/FRONTEND-DISCOVERY.md § Page inventory (Coming soon, Confirm wait list)

## Setup
- The web Worker serves `rarepair.fans` with its `PRELAUNCH` setting on, unless a case says it is off
- A `waitlist` table exists in Postgres (ARCHITECTURE, *Data model*)
- Turnstile is configured on the wait list form; a test Turnstile token that passes and one that fails are available
- The Workers rate-limiting binding is configured per IP and per email for `POST /waitlist`
- The web Worker puts wait list confirmation emails on the `email` queue; launch emails go on the `email-bulk` queue; the mailer Worker consumes both, with a stub Resend sender capturing sent messages
- Emails in these cases are test addresses only

## Cases

### Coming-soon page shows the wait list form
- GIVEN `PRELAUNCH` is on and a visitor with JavaScript on
- WHEN they open `/`
- THEN the page says rarepair is coming soon and shows an email address form with Turnstile alongside
- AND it says the address gets one email when the archive opens, and nothing else

### Coming-soon page without JavaScript explains the form needs it
- GIVEN `PRELAUNCH` is on and a visitor with JavaScript off
- WHEN they open `/`
- THEN the rest of the page renders, and a `<noscript>` message says joining the wait list needs JavaScript
- AND no wait list request can be submitted from the page

### Coming-soon page allows the Turnstile frame and nothing more
- GIVEN `PRELAUNCH` is on
- WHEN `/` is requested
- THEN its CSP header is the strict policy plus exactly `frame-src https://challenges.cloudflare.com`, as on the other Turnstile pages

### Coming-soon page serves its own fonts
- GIVEN `PRELAUNCH` is on
- WHEN a visitor opens `/`
- THEN its headings and text are set in Fraunces and its labels and buttons in IBM Plex Mono, each loaded as woff2 from `rarepair.fans` with `font-display: swap`
- AND the woff2 files are the font publishers' own, unmodified, served at content-hashed paths with `Cache-Control: public, max-age=31536000, immutable`
- AND the page's HTML and its stylesheets reference no font, stylesheet or script on any other host except Turnstile's `api.js`
- AND the fonts' OFL licence files are served from `rarepair.fans` too
- AND the other wait list pages (check your email, confirm, unsubscribe) use the same fonts, and no other app page loads a web font

### Other app pages are closed before launch
- GIVEN `PRELAUNCH` is on
- WHEN a visitor opens any app page other than `/`, the `/waitlist` pages, `/terms`, `/privacy`, sign-in (`/login`, `/login/confirm`), `/welcome/terms`, sign-out or `/admin`
- THEN they are redirected to `/` with a 302
- AND `content.rarepair.fans` is unaffected

### Joining queues one confirmation email
- GIVEN an address that is not on the wait list and a passing Turnstile token
- WHEN the visitor submits the form, a plain `application/x-www-form-urlencoded` POST to `/waitlist`
- THEN a `waitlist` row is created for the address, trimmed and lowercased, with `confirmed_at` empty
- AND one email linking to `https://rarepair.fans/waitlist/confirm` with a token is put on the `email` queue
- AND only a hash of the token is stored, never the token itself, and it is valid for 7 days
- AND the response is a "Check your email to confirm" page

### Joining twice tells nobody anything
- GIVEN an address that is already on the wait list, confirmed or not
- WHEN it is submitted again with a passing Turnstile token
- THEN the response is the same "Check your email to confirm" page as for a new address, with the same status code
- AND a confirmed address gets no email
- AND an unconfirmed address gets a fresh confirmation email only if its last one was sent more than an hour ago and it has had fewer than 3 in all; the new token replaces the old one
- AND once an unconfirmed address has had 3 confirmation emails, it gets no more, whatever is submitted

### Two joins for the same address at once
- GIVEN an address that is not on the wait list
- WHEN two `POST /waitlist` requests for it, each with a passing Turnstile token, arrive at the same time
- THEN exactly one `waitlist` row exists afterwards and exactly one confirmation email is queued
- AND both responses are the same "Check your email to confirm" page, with the same status code

### Join request without Turnstile is refused
- GIVEN a visitor
- WHEN they submit `POST /waitlist` with a missing or failing Turnstile token
- THEN no row is written and no email is queued
- AND the response is 400 and shows the form again with an error

### Join request without a valid address is refused
- GIVEN a visitor with a passing Turnstile token
- WHEN they submit `POST /waitlist` with no address, or anything the mailer's message contract would refuse: longer than 254 characters, no `@`, a display name, a list, or whitespace or any of `<>()",;:\[]`
- THEN no row is written and no email is queued
- AND the response is 400 and shows the form again with an error

### Cross-site join request is refused
- GIVEN a `POST /waitlist` whose `Origin` is present and is not exactly `https://rarepair.fans`, or whose `Sec-Fetch-Site` is present and is not `same-origin`
- WHEN the web Worker receives it
- THEN the response is 403
- AND no row is written and no email is queued

### Join requests are rate-limited per IP
- GIVEN one IP address that has reached the wait list rate limit within the current window
- WHEN it submits another `POST /waitlist`, even for a different address
- THEN the response is 429 with a `Retry-After` header, no row is written and no email is queued
- AND a plain page says when to try again

### Join requests are rate-limited per email
- GIVEN one address that has reached the wait list rate limit within the current window
- WHEN another `POST /waitlist` is submitted for that address from a different IP
- THEN the response is 429 with a `Retry-After` header and no email is queued
- AND a plain page says when to try again

### Opening the confirmation link uses nothing up
- GIVEN an unconfirmed address with a token issued less than 7 days ago
- WHEN the link `GET /waitlist/confirm?token=<token>` is opened, as a mail scanner prefetching it would
- THEN the page shows a "Confirm" button in a POST form
- AND `confirmed_at` is still empty

### Confirming puts the address on the list
- GIVEN an unconfirmed address with a token issued less than 7 days ago
- WHEN the visitor presses "Confirm", submitting `POST /waitlist/confirm` with the token, with or without JavaScript
- THEN `confirmed_at` is set and the token hash is cleared, so the link can't be used again
- AND the page says "You're on the list" and that one email will follow when rarepair opens

### Used, expired or unknown confirmation links are refused plainly
- GIVEN a confirmation token that was already used, was issued more than 7 days ago, or was never issued
- WHEN `POST /waitlist/confirm` is submitted with it
- THEN nothing changes in `waitlist`
- AND the page says the link is used or expired, with a link back to `/` to join again

### The wait list keeps only what the launch email needs
- GIVEN any join, resend or confirm request
- WHEN it is handled
- THEN the `waitlist` row holds only the address, the token hashes and their times, `confirmed_at` and `notified_at`, with no IP address, user agent or referrer
- AND no log line, in the web Worker or the mailer, contains the address or a link

### The launch send emails each confirmed address once
- GIVEN confirmed and unconfirmed addresses on the wait list, and the operator's launch send script with its secrets in the environment
- WHEN the script runs
- THEN each confirmed address with `notified_at` empty gets `notified_at` set, the hash of a fresh unsubscribe token stored, and one launch email put on the `email-bulk` queue as JSON, in batches
- AND a batch whose enqueue fails has `notified_at` cleared again, so the next run picks it up
- AND unconfirmed addresses get no email
- AND running it again, at the same time or later, puts no address on the queue a second time

### The launch send script resumes where it stopped
- GIVEN more confirmed addresses than one batch, and a run that stopped partway
- WHEN the script is run again
- THEN only the addresses with `notified_at` empty are put on the queue
- AND it reports how many confirmed addresses are still waiting, 0 when the run has finished

### A launch email that can't be sent is tried again
- GIVEN a launch email that both providers refuse until the queue dead-letters it
- WHEN the web Worker takes it off the `email-bulk` dead-letter queue
- THEN that address's `notified_at` is cleared, so the next run of the launch send script queues it again
- AND the message is not kept on the dead-letter queue, and nothing prints its address to logs

### The launch send is spread out
- GIVEN tens of thousands of confirmed addresses
- WHEN the launch send runs
- THEN the mailer sends launch emails through Resend's batch API at no more than the configured rate, so they arrive over hours, not at once

### Sign-in emails are not delayed by the launch send
- GIVEN the launch send has queued thousands of launch emails
- WHEN a visitor requests a sign-in link
- THEN its email is sent from the `email` queue without waiting behind the launch emails on `email-bulk`
- AND the launch send's rate leaves room under Resend's per-second API limit for sign-in emails

### The launch email has a one-click unsubscribe
- GIVEN a launch email
- WHEN it is built
- THEN it carries `List-Unsubscribe` with an `https://rarepair.fans/waitlist/unsubscribe` link holding a token, and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- AND a `POST` to that link deletes the address's row and answers 200, with no sign-in and no page to click through
- AND that `POST` is exempt from the `Origin` / `Sec-Fetch-Site` check, since mail providers send it from their own servers
- AND opening the link in a browser (`GET`) shows an "Unsubscribe" button in a POST form, and changes nothing until it is pressed
- AND the link keeps working with `PRELAUNCH` off, and a `POST` with a token whose row is already gone (unsubscribed or purged) also answers 200

### The wait list is deleted after the launch send
- GIVEN the launch send has finished, and the operator's purge script (`scripts/waitlist-purge.mjs`) has `DATABASE_URL` in its environment
- WHEN the operator runs it
- THEN every `waitlist` row is deleted, confirmed or not, and the script prints how many
- AND it refuses, deleting nothing, while any confirmed address still has `notified_at` empty, or the newest `notified_at` is less than 24 hours old (so a dead-lettered email can still come back), unless run with `--force`
- AND a list with no confirmed address is purged, an empty list succeeds with 0, and the script prints no address and no raw error

### After launch the archive takes over
- GIVEN `PRELAUNCH` is off
- WHEN a visitor opens `/`
- THEN they see the home page, with no wait list form
- AND `POST /waitlist` answers 404, and `/waitlist/confirm` shows a plain page saying the archive is open, with a link to `/`

### Privacy notice covers the wait list
- GIVEN `PRELAUNCH` is on
- WHEN a visitor opens `/privacy`
- THEN it says the wait list keeps only the address, sends one confirmation email and one launch email, and is deleted after launch
