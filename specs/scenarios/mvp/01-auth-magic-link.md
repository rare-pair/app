# Scenario: Magic-link sign-in and sessions

Relates to: docs/ARCHITECTURE.md § Auth (magic link: Better Auth + Resend), § Data model, § Surge controls; docs/FRONTEND-DISCOVERY.md § Decisions so far (JavaScript), § Key journeys (2. Sign in), § Page inventory (Sign in, Accept terms, Too many requests), § Where the frontend changes the architecture (1. Forms with Turnstile need JS)

## Setup
- The web Worker serves `rarepair.fans` with `/login` and `/login/confirm`, and builds a Better Auth instance (magic-link plugin) per request from its bindings, with `baseURL` `https://rarepair.fans` and only that origin in `trustedOrigins`
- Better Auth's `user`, `session`, `account` and `verification` tables exist in Postgres; magic-link tokens are stored hashed in `verification`; `user` has a `terms_accepted_at` field
- Turnstile is configured on the sign-in form; a test Turnstile token that passes and one that fails are available
- The Workers rate-limiting binding is configured per IP and per email for `POST /login`
- The web Worker puts sign-in emails on the `email` queue; the mailer Worker (`apps/mailer`) consumes it, with a stub Resend sender capturing sent messages and a failover provider stub (Postmark or SES) wired in
- No passwords are stored anywhere
- `disableSignUp` is not set, so Better Auth creates an account for an unknown email when its link is confirmed

## Cases

### Sign-in page shows an email form
- GIVEN a signed-out visitor with JavaScript on
- WHEN they open `/login`
- THEN the page shows an email address form with Turnstile alongside

### Sign-in page without JavaScript explains it is needed
- GIVEN a signed-out visitor with JavaScript off
- WHEN they open `/login`
- THEN the page shows a `<noscript>` message saying signing in needs JavaScript
- AND no sign-in request can be submitted from the page

### Requesting a magic link queues an email with a single-use token
- GIVEN a signed-out visitor with a valid email address and a passing Turnstile token
- WHEN they submit the `/login` form, a plain `application/x-www-form-urlencoded` POST
- THEN an email linking to `https://rarepair.fans/login/confirm` with a token is put on the email queue, whatever host the request came in on
- AND only a hash of the token is stored in the `verification` table, never the token itself
- AND the token is valid for 15 minutes

### Check-your-email page sets expectations
- GIVEN a visitor who has just submitted a valid sign-in request
- WHEN the response page renders
- THEN a "Check your email" page says the link lasts 15 minutes
- AND it says the link can take a minute to arrive during busy periods

### Login request without Turnstile is refused
- GIVEN a signed-out visitor
- WHEN they submit `POST /login` with a missing or failing Turnstile token
- THEN no token is created and no email is queued
- AND the response is 400 and shows the sign-in form again with an error

### Cross-site login request is refused
- GIVEN a `POST /login` whose `Origin` is present and is not exactly `https://rarepair.fans` (another site, or another `rarepair.fans` host such as `content.rarepair.fans`), or whose `Sec-Fetch-Site` is present and is not `same-origin`
- WHEN the web Worker receives it
- THEN the response is 403
- AND no token is created and no email is queued

### Login requests are rate-limited per IP
- GIVEN one IP address that has reached the login rate limit within the current window
- WHEN it submits another `POST /login`, even for a different email address
- THEN the response is 429 with a `Retry-After` header and no email is queued
- AND a plain page says when to try again

### Login requests are rate-limited per email
- GIVEN one email address that has reached the login rate limit within the current window
- WHEN another `POST /login` is submitted for that email from a different IP
- THEN the response is 429 with a `Retry-After` header and no email is queued
- AND a plain page says when to try again

### Opening the emailed link uses nothing up
- GIVEN an unused token issued less than 15 minutes ago, and a browser with no sign-in marker
- WHEN the link `GET /login/confirm?token=<token>` is opened, as a mail scanner prefetching it would
- THEN the page shows a "Sign in" button in a POST form
- AND the token is still unused and no session is created

### The browser that asked for the link signs in without a press
- GIVEN a browser whose `POST /login` was accepted, which still holds the marker, and an unused token
- WHEN it opens the emailed link with JavaScript on
- THEN it is signed in and redirected to its `next`, and nothing was pressed

### The marker posts whichever link is opened
- GIVEN a browser holding the marker
- WHEN it opens an older sign-in link, used or expired
- THEN the page posts by itself and lands on the used-or-expired message
- AND the marker is gone, so its newest link then takes a press
- AND, as an accepted limit (#606, #657), someone who asked for their own link and opens, or is navigated to, a planted one within 15 minutes is signed in to the planter's account with no press

### Opening the link still uses nothing up
- GIVEN an unused token
- WHEN `GET /login/confirm` is opened, with or without the marker
- THEN it spends no token and creates no session
- AND only `POST /login/confirm` does, with its origin check unchanged

### Another browser still gets the button
- GIVEN an unused token and a browser with no marker
- WHEN it opens the emailed link
- THEN the page has the "Sign in" button and no script
- AND the token stays unused until the button is pressed

### A browser with JavaScript off still gets the button
- GIVEN a browser with the marker and JavaScript off
- WHEN it opens the emailed link and presses "Sign in"
- THEN it is signed in

### Going back after signing in shows no error
- GIVEN a browser with the marker, and sign-in open (before launch both routes redirect)
- WHEN the Worker's `POST /login/confirm` route answers it in any way, a refusal or a fault included
- THEN the answer clears the marker, so going back to or reloading the link page posts nothing by itself

### A refused request sets no marker
- GIVEN a `POST /login`
- WHEN the origin check, Turnstile or a rate limit refuses it, or its address or size is refused
- THEN it sets no marker
- AND an accepted request sets it the same way whether or not the address has an account

### The marker says nothing about who asked
- GIVEN an accepted `POST /login`
- WHEN its marker cookie is set
- THEN it holds nothing about the address, the token or the account
- AND it has `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and no `Domain`, and lasts no longer than the newest link it was set for
- AND it isn't treated as a session, and a signed-out reader holding it still gets edge-cached chapter pages

### Confirming signs the user in
- GIVEN an unused token issued less than 15 minutes ago
- WHEN the user presses "Sign in", submitting `POST /login/confirm` with the token
- THEN the token's `verification` row is deleted
- AND a session row is created in Postgres
- AND the cookie `__Secure-better-auth.session_token` is set with `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`
- AND the cookie has no `Domain` attribute, so it covers `rarepair.fans` only and never `content.rarepair.fans`

### Confirming works without JavaScript
- GIVEN an unused token and a browser with JavaScript off and no marker
- WHEN the user opens the emailed link and presses "Sign in"
- THEN they are signed in and redirected, with no script involved

### Token cannot be used twice
- GIVEN a token that has already been used to sign in
- WHEN `POST /login/confirm` is submitted with it again
- THEN no new session is created and no session cookie is set
- AND the response redirects to `/login`, which shows a plain message that the link is used or expired

### Concurrent use of the same token creates at most one session
- GIVEN an unused, unexpired token
- WHEN two `POST /login/confirm` requests with that token arrive at the same time, through different Worker isolates
- THEN exactly one of them creates a session, because the token is consumed by a single `DELETE … RETURNING` in Postgres

### Expired token is refused
- GIVEN a token issued more than 15 minutes ago and never used
- WHEN `POST /login/confirm` is submitted with it
- THEN no session is created
- AND the response redirects to `/login`, which shows a plain message that the link is used or expired

### Unknown token is refused
- GIVEN a token value that was never issued
- WHEN `POST /login/confirm` is submitted with it
- THEN no session is created
- AND the response redirects to `/login`, which shows a plain message that the link is used or expired

### Sign-in returns the user to where they started
- GIVEN a signed-out visitor who started signing in from a work page
- WHEN they complete sign-in through the emailed link
- THEN they are redirected back to that work page, using the same-site `next` path our `/login` route stored

### Sign-in never acts as an open redirect
- GIVEN a sign-in request whose `next` is an external or protocol-relative URL (`https://evil.example`, `//evil.example`, `/\evil.example`)
- WHEN the user completes sign-in through the emailed link
- THEN they are redirected within `rarepair.fans` (the home page), never to the external URL

### Sign-in emails go through Resend in batches
- GIVEN several sign-in emails waiting on the email queue
- WHEN the mailer Worker takes them off the queue
- THEN it sends them through Resend's batch API rather than one API call per email

### Email sending fails over to the second provider
- GIVEN Resend is refusing messages (rate limit, quota or outage)
- WHEN a sign-in email is taken off the email queue
- THEN it is sent through the failover provider instead

### New email creates an account on confirm
- GIVEN an email address with no account, and an unused token issued to it less than 15 minutes ago
- WHEN the user presses "Sign in", submitting `POST /login/confirm` with the token
- THEN a `user` row is created for that email, with `terms_accepted_at` empty
- AND a session is created for the new account

### New account must accept the terms before continuing
- GIVEN a new account, signed in with `terms_accepted_at` empty, that started signing in from a work page
- WHEN it opens any page other than `/welcome/terms`, `/terms`, `/privacy`, `/about`, removal requests (`/remove`), copyright notices (`/dmca`), sign-in or sign-out (or `/admin`, which answers a non-moderator 404, and static files)
- THEN it is redirected to `/welcome/terms`
- AND once it accepts there, `terms_accepted_at` is set and it continues to the work page it started from

### Returning user skips the terms page
- GIVEN an existing account whose `terms_accepted_at` is set
- WHEN it signs in again through an emailed link
- THEN it goes straight to its `next` page and is never shown `/welcome/terms`

### Sign-out ends the session and clears the cookie
- GIVEN a signed-in user
- WHEN the "Sign out" button on `/logout` posts `POST /logout` from the site
- THEN the user's `session` row is deleted
- AND the response clears the session cookie (`Max-Age=0`, with the `Secure`, `HttpOnly` and `SameSite=Lax` it was set with, and no `Domain`) and redirects to `/` with a 303

### A failed delete does not report a successful sign-out
- GIVEN a signed-in user whose `session` row can't be deleted (Postgres refuses the delete)
- WHEN `POST /logout` arrives from the site
- THEN the response is a 500 page that says sign-out didn't work and asks the person to try again, with the same "Sign out" button
- AND it does not clear the session cookie and has no `Clear-Site-Data`, and nothing on it says the person is signed out
- AND the session row and the cookie still work, and posting again once the database recovers signs out as usual
- AND this holds in production once the check's read is on the uncached `HYPERDRIVE` binding (deploy step 4 in ARCHITECTURE's *Connections*)
- AND the check runs for the session the request's cookie resolved to: a cookie that resolves to none gets the "without a session" answer

### Sign-out with the database unreachable is not a success and logs no address
- GIVEN a signed-in user and a database the Worker can't reach
- WHEN `POST /logout` arrives from the site (it fails at the session lookup, before the route; no seam makes only the route's own read fail)
- THEN the response is a 5xx with no cookie change and no `Clear-Site-Data`
- AND the log holds no email address

### Sign-out empties the browser's cache and keeps the reader's settings
- GIVEN a signed-in user
- WHEN `POST /logout` is answered
- THEN the response carries `Clear-Site-Data: "cache"`, and no other value
- AND the only cookies it sets are Better Auth's, so the reader's settings cookies stay
- AND in a browser that ignores the header, listings may still be cached for their own short lifetime (not tested; Chromium honours it)

### The sign-out button works without JavaScript
- GIVEN a signed-in user in a browser with JavaScript off
- WHEN they press "Sign out" on `/logout`
- THEN they land on the home page, signed out, and `/me/uploads` sends them to `/login`

### Sign-out without a session answers the same
- GIVEN a visitor with no session cookie, a forged one, or the cookie of a session that was already signed out (a second tab)
- WHEN they post `POST /logout`
- THEN the response is the same 303 to `/`, with the cookie cleared and `Clear-Site-Data: "cache"`, and no error

### A cross-site sign-out is refused
- GIVEN a signed-in user
- WHEN `POST /logout` arrives with another site's `Origin`, with `Sec-Fetch-Site` `cross-site` or `same-site`, or with neither header
- THEN the response is 403 and sets no cookie
- AND the session row and the cookie are untouched
- AND the page does not tell the visitor to sign in

### Opening the sign-out page signs nobody out
- GIVEN a signed-in user
- WHEN they open `GET /logout` (or `HEAD`)
- THEN the page shows a "Sign out" button that posts to `/logout`, and needs no script
- AND the session row and the cookie are untouched, so a link prefetch or another site can't sign them out

### The sign-out page says when nobody is signed in
- GIVEN a visitor with no session, or with the cookie of a session that was signed out
- WHEN they open `GET /logout`
- THEN the page says they are not signed in, with a link to sign in, and has no sign-out button

### A signed-out cookie reads as signed out
- GIVEN a user who signed out
- WHEN a request carries the session cookie it had before
- THEN the request is signed out: `/logout` says so and `/me/uploads` redirects to `/login`
- AND this holds in production once the session lookup is on the uncached `HYPERDRIVE` binding (deploy step 4 in ARCHITECTURE's *Connections*)

### A refresh due on the sign-out request does not undo it
- GIVEN a signed-in user whose session is due to be extended
- WHEN they post `POST /logout`
- THEN the response carries one `session_token` cookie, the clearing one

### Sign-out works before launch and before the terms are accepted
- GIVEN `PRELAUNCH` is on, or an account whose `terms_accepted_at` is empty
- WHEN it opens `GET /logout` or posts `POST /logout`
- THEN it is not redirected to `/` or to `/welcome/terms`, and the post signs it out

### Reading needs no account
- GIVEN a signed-out visitor with no session cookie
- WHEN they open the home page, a work page and a chapter of a live work
- THEN every page renders without asking them to sign in

### Uploading needs an account
- GIVEN a signed-out visitor
- WHEN they open `/upload`, or their browser's script calls `POST /uploads`
- THEN opening `/upload` redirects them to sign in, carrying `next=/upload`
- AND `POST /uploads` answers 401, since a script can't follow a sign-in redirect
- AND no `uploads` row is inserted and no presigned URL is returned
