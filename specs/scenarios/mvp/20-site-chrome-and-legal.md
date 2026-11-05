# Scenario: Temporary banner, branding, legal pages and shared page chrome

Relates to: docs/ARCHITECTURE.md § Opening, § MVP vs later (8. Terms, privacy notice and banner); docs/FRONTEND-DISCOVERY.md § Decisions so far (Branding), § Principles (4. Honest about being temporary), § Page inventory (About / terms / privacy, Not found), § Components (Flash message, Temporary banner), § Copy and tone

## Setup
- The web Worker serves every app page with the shared layout
- A signed-out visitor, a signed-in user and a moderator

## Cases

### Temporary banner on every page
- GIVEN any app page, including the reader, upload, remove and admin pages
- WHEN it renders
- THEN one line at the very top says this is an unofficial stopgap and links to `/about`

### No AO3 or OTW branding
- GIVEN any app page
- WHEN it renders
- THEN it uses no AO3 or OTW name, logo, symbols or site styling, and does not imply affiliation or approval

### Ratings and warnings are text, not symbols
- GIVEN any page showing a rating or warning
- WHEN it renders
- THEN they are spelled-out text badges, not symbol icons

### About, terms and privacy pages
- GIVEN any visitor
- WHEN they open `/about`, `/terms` and `/privacy`
- THEN each is a static page that renders without sign-in or JavaScript

### The privacy page says requester data is kept until the site closes
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN it says a request keeps the requester's email address, a hashed form of their network address, and the work or pseud they named
- AND it says the archive keeps that until the site closes, and then deletes it
- AND it says the archive does not erase it when a requester asks

### The privacy page says what a copyright notice keeps
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN it says a copyright notice keeps the sender's name, address, telephone number and email address, and their signature
- AND it says moderators read a notice to act on it
- AND it says a notice sent by email is read by a person and stays in that mailbox
- AND it says the archive keeps notices until the site closes, and then deletes them
- AND it says the archive does not erase them when a sender asks

### Footer links to removal
- GIVEN any app page
- WHEN it renders
- THEN the footer has a "Remove my work" link to `/remove`
- AND a "Removed works" link to `/removed`

### Site header for a signed-out visitor
- GIVEN a signed-out visitor
- WHEN any app page renders
- THEN the header has a "Search" link to `/search`, an "Add work" link to `/upload` and a "Sign in" link to `/login`, in that order
- AND it has no "My uploads", "Admin" or "Sign out"

### Site header for a signed-in user
- GIVEN a signed-in user who is not a moderator
- WHEN any app page renders
- THEN the header has, in order, "Search", "Add work", "My uploads" (to `/me/uploads`) and a "Sign out" button
- AND the button is in a form that posts to `/logout`, so it works with JavaScript off and by keyboard
- AND there is no "Sign in" and no "Admin" link, and the header shows no name or address

### Site header for a moderator
- GIVEN a signed-in moderator or admin
- WHEN any app page renders
- THEN the header has "Search", "Add work", "My uploads", "Admin" (to `/admin`) and "Sign out", in that order
- AND nobody else is shown "Admin", and `/admin` still answers anyone else with the same not-found page as any unknown URL

### Site header has Search for every visitor
- GIVEN any visitor, signed out, signed in or a moderator
- WHEN any app page renders
- THEN "Search" is the first link in the header's navigation, and it goes to `/search` (before launch it is disabled, see "Site header before launch"; a page answered before the session has the bare header)
- AND `/search` with no query, or a blank one, is the search page: the search box, no results

### Site header for an account that has not accepted the terms
- GIVEN a signed-in account that has not accepted the terms
- WHEN a page that is open to it renders
- THEN the header is the signed-in one, as ruled
- AND "Search", "Add work" and "My uploads" lead back to the terms page until they are accepted, since the terms gate sends the account there (it has no exception for `/search`)

### Pages without the full header
- GIVEN a cross-site post refused before the session is read, or a missing static file
- WHEN the refusal page renders
- THEN a refusal before the session shows the bare site name, with no links
- AND a missing static file's 404 shows the signed-out links, whoever asks

### Site header before launch
- GIVEN the archive before launch
- WHEN a page renders its header
- THEN "Search", "Add work", "My uploads" and "Sign in" show disabled, as the footer's "Remove my work" link does: no `href`, `aria-disabled="true"`, skipped by Tab, because `/search`, `/upload`, `/me/uploads` and `/login` are closed
- AND "Sign out" and "Admin" stay live

### Site header is never in a shared cache
- GIVEN a signed-in user or a moderator opens a chapter
- WHEN a signed-out reader opens the same chapter afterwards
- THEN the signed-out reader sees the signed-out header, never Sign out or Admin
- AND the signed-in request neither read nor wrote the edge page cache (see 11, "Fresh nonce on edge-cached pages")
- AND the cached entry holds no header

### Site header fits a narrow screen
- GIVEN a moderator's header, the longest
- WHEN the page renders at 360 px wide
- THEN the links wrap onto more lines and nothing scrolls sideways (see 21, "No sideways scrolling at 360 px")

### Not-found page
- GIVEN a URL that matches no page
- WHEN a visitor opens it
- THEN the page shows a search box and a home link

### A short page fills the screen
- GIVEN a short page, such as a refusal or the confirm sign-in page
- WHEN it renders at 1280×800 and at 360 px wide
- THEN the footer's bottom edge is at the bottom of the screen
- AND the page doesn't scroll
- AND the header, main and footer keep their centred column width, and the banner stays full width

### A long page scrolls with the footer after its content
- GIVEN a page taller than the screen, such as the entire work
- WHEN it renders
- THEN the footer follows the content, and scrolling to the end brings the whole of the content and then the footer into view

### Flash message after a POST
- GIVEN a form that POSTs and redirects, such as reader settings
- WHEN the redirected page renders
- THEN a one-line notice shows at the top, carried over the redirect in a short-lived cookie

### Credit goes to the original work
- GIVEN any work page
- WHEN it renders
- THEN credit is given through a link to the original AO3 work URL
