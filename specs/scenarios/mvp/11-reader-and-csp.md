# Scenario: Chapter reader and strict CSP

Relates to: docs/ARCHITECTURE.md § Decisions so far (Chapter rendering, Name and domain), § Why these pieces (Hosts), § Reading, § Author requests & takedowns (What hidden, held and removed works show); docs/FRONTEND-DISCOVERY.md § Key journeys (1. Find and read a work), § Page inventory (Chapter reader, Entire work, Hidden work, Removed work), § Components (Chapter nav, Review notice), § Reading experience

## Setup
- A live work W with 5 chapters, chapter notes on chapter 2 and end notes on chapter 2, rated General Audiences with no archive warnings
- Chapter fragments are stored in R2 under the version's prefix
- A chapter fixture containing an injected `<script>` that survived the sanitizer (test-only)
- The pages with a Turnstile check are `/login`, `/upload`, `/remove` and `/dmca`
- A live work F whose current version has review reasons no moderator has cleared
- A work H hidden after reader reports, and a work R in status `removed`

## Cases

### Chapter renders inline in the page
- GIVEN live work W
- WHEN a reader opens `/works/:id/chapters/2`
- THEN the sanitized chapter fragment is server-rendered inline inside `<article class="chapter">`
- AND the page contains no `<iframe>` and no client-side epub engine

### Every app page sends the strict CSP
- GIVEN any page served by `rarepair.fans` without a Turnstile check
- WHEN the response is returned
- THEN it has the header `default-src 'self'; script-src 'nonce-{n}' 'strict-dynamic'; style-src 'self'; img-src 'self' https://content.rarepair.fans; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`

### Every response requires HTTPS
- GIVEN any response from the web Worker, a Turnstile page, an error page or a redirect included
- WHEN it is returned
- THEN it has the header `Strict-Transport-Security: max-age=31536000; includeSubDomains`

### Requests to www go to the bare domain
- GIVEN any request to `www.rarepair.fans`, of any method, with any path and query
- WHEN the web Worker receives it
- THEN the response is 308 with `Location` set to the same path and query on `https://rarepair.fans`
- AND the request is not otherwise handled, so no page, cookie or form action is served on `www.rarepair.fans`

### Turnstile pages allow only the Turnstile challenge frame
- GIVEN `/login`, `/upload` and `/remove` (and `/` while `PRELAUNCH` is on, which specs/scenarios/mvp/22-waitlist.md covers)
- WHEN each response is returned
- THEN its CSP header is the strict policy plus exactly `frame-src https://challenges.cloudflare.com`, and nothing else is added
- AND Turnstile's `api.js` loads through a `<script>` carrying the page nonce, covered by `'strict-dynamic'`

### Reader and work pages never allow third-party frames
- GIVEN a work page, a chapter page and an entire-work page of W
- WHEN each response is returned
- THEN its CSP header has no `frame-src https://challenges.cloudflare.com` and allows no third-party frame

### Nonce is fresh per response
- GIVEN the same chapter page requested twice
- WHEN both responses are returned
- THEN each has a different nonce in its CSP header

### Fresh nonce on edge-cached pages for signed-out readers
- GIVEN a chapter page served to signed-out readers from a short edge cache
- WHEN two signed-out readers request it
- THEN each response still carries its own nonce

### Script that gets past the sanitizer does not run
- GIVEN the test chapter containing an injected `<script>` without the page nonce
- WHEN the chapter page is loaded in a browser
- THEN the script does not execute

### Page cannot be framed
- GIVEN any app page
- WHEN another origin tries to embed it in a frame
- THEN the browser refuses because of `frame-ancestors 'none'`

### Chapter content is contained
- GIVEN the reader stylesheet
- WHEN a chapter page renders
- THEN `.chapter` has `contain: content` and positioning stays locked inside it

### Chapter nav at both ends
- GIVEN chapter 3 of W
- WHEN the page renders
- THEN previous, a chapter `<select>` and next appear at both the top and the bottom of the chapter

### Chapter select works without JS
- GIVEN chapter 3 of W with JavaScript off
- WHEN the reader picks chapter 5 in the `<select>` and presses its form button
- THEN chapter 5 opens

### First chapter has no previous link
- GIVEN chapter 1 of W
- WHEN the page renders
- THEN there is no previous-chapter link

### Last chapter has no next link
- GIVEN chapter 5 of W
- WHEN the page renders
- THEN there is no next-chapter link

### Notes surround the chapter text
- GIVEN chapter 2 of W with chapter notes and end notes
- WHEN the page renders
- THEN chapter notes come before the text and end notes after it, in a smaller, muted style
- AND the work summary is not repeated

### Slim top bar
- GIVEN any chapter of W
- WHEN the page renders
- THEN the only chrome is a slim top bar with the work title and a settings link, which scrolls away

### Entire work on one page
- GIVEN live work W
- WHEN a reader opens `/works/:id/full`
- THEN every chapter is shown on one page in order

### Reader pages show the may-be-imperfect notice
- GIVEN live work F
- WHEN a reader opens one of its chapters or `/works/:id/full`
- THEN the page shows "Chapters may be imperfect; a moderator will check."

### Hidden work's chapters and entire work return 451
- GIVEN work H hidden after reader reports
- WHEN anyone opens any `/works/:id/chapters/:n` or `/works/:id/full` of H
- THEN the response status is 451, except for a declared automated client, which gets the 403 in specs/scenarios/mvp/24-crawler-and-agent-blocking.md
- AND the page says only "Temporarily hidden after reader reports", with no chapter text or other details

### Removed work's chapters and entire work return 410
- GIVEN work R in status `removed`
- WHEN anyone opens any `/works/:id/chapters/:n` or `/works/:id/full` of R
- THEN the response status is 410, except for a declared automated client, which gets the 403 in specs/scenarios/mvp/24-crawler-and-agent-blocking.md
- AND the page says "This work has been removed" with no details

### Chapter number out of range
- GIVEN live work W with 5 chapters
- WHEN a reader opens `/works/:id/chapters/6`
- THEN no chapter is rendered and the not-found page is shown

### Browser features keep working
- GIVEN a chapter page
- WHEN the reader uses Ctrl+F, prints, selects text or uses a screen reader
- THEN the chapter text is found, printed, selectable and read as normal page content

### Same fragment serves every reader
- GIVEN two readers with different font, spacing and theme settings
- WHEN they open the same chapter
- THEN both pages embed the identical chapter fragment, served from the Worker's Cache API after the first read

### Fragments are immutable per version
- GIVEN a work whose current version was replaced
- WHEN a reader opens a chapter
- THEN the fragment comes from the new version's prefix, and the old version's fragments are unchanged
