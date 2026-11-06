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

### The privacy page says asking for a sign-in link sets a cookie that holds nothing about you
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN it says asking for a sign-in link sets a short-lived cookie that holds nothing about them

### The privacy page lists the cookies and what they are for
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN a Cookies section names each cookie the Worker sets, and Cloudflare's `__cf_bm` and `cf_clearance`, with what each is for
- AND it says none is for advertising or analytics

### The terms apply to everyone who uses the site
- GIVEN any visitor
- WHEN they open `/terms`
- THEN it says using the site means agreeing to the terms, and that new accounts are also asked to accept them once

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

### The privacy page says how to ask for an account to be deleted
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN it says to ask at admin@rarepair.fans
- AND it says the archive deletes the account, its sessions and its saved reading positions
- AND it says accepted works stay public
- AND it says reports the account made stay, and that the email asking stays in that mailbox
- AND it says a banned account is not deleted

### Footer links to removal
- GIVEN any app page
- WHEN it renders
- THEN the footer has a "Remove my work" link to `/remove`

### Footer links to the GitHub repository
- GIVEN any app page, before launch and after
- WHEN it renders
- THEN the footer has a "GitHub" link to `https://github.com/rare-pair/app`
- AND before launch it stays live, because it leaves the site and no closed page is behind it

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
- THEN a refusal before the session shows the bare site name with its star (see "The logo is in the site header"), with no links
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

### The logo is in the site header
- GIVEN any app page, including a refusal answered before the session lookup, which shows the bare header
- WHEN it renders
- THEN the header's home link reads ✯ before "rarepair"
- AND the star follows the site name's colour in both themes

### The logo isn't read out
- GIVEN the header's home link
- WHEN assistive technology reads it
- THEN the star is hidden from it, so the link's accessible name stays exactly "rarepair"

### The tab shows the star
- GIVEN any app page, before launch and after, with no sign-in
- WHEN it renders
- THEN it declares one icon, an SVG we drew ourselves, with no text, script or outside reference
- AND the icon answers 200 from `rarepair.fans` with an image content type, with no session lookup and no cookie
- AND the page's content security policy lets it load, with no violation

### A work page has a card
A link preview service that identifies itself is refused every page (spec 24, operator ruling 2026-11-06), so these cards reach only clients that aren't refused. They stay because they cost nothing.

- GIVEN a live work with a title, one or more pseuds, a rating, archive warnings and fandoms
- WHEN its work page is fetched
- THEN it carries `og:title` (the work's title), `og:description`, `og:site_name` (rarepair), `og:type` (`article`), `og:url` and `twitter:card` (`summary`), and no `og:image`
- AND the description runs, joined by " · ": "by" and the byline, the rating, every archive warning, then the fandoms
- AND a work with no author says "Anonymous", one with no rating says "Not Rated", and one with a blank title has the title "Untitled work"
- AND `og:url` is the work page's own address on `rarepair.fans`, with no query

### A work's card has no summary
- GIVEN works with a summary, one Mature, one General and one with no rating
- WHEN their work pages are fetched
- THEN no card tag holds any of the summary's text

### The other public pages share the site card
- GIVEN the home page, search with and without a query, a tag listing with and without filters and a page number, a tag with no works, `/about`, `/terms`, `/privacy`, `/remove` and `/dmca`
- WHEN each is fetched
- THEN each carries `og:title` rarepair, `og:description` "An unofficial, temporary, community-run reading archive for fanworks.", `og:site_name`, `og:type` (`website`) and `twitter:card` (`summary`), with no `og:url` and no `og:image`
- AND no card repeats the search query or the tag

### Chapters have no card
- GIVEN a work, with a Mature one that shows the warnings screen first
- WHEN a chapter, `/works/:id/full`, `/works/:id/chapters` or the warnings screen is fetched, by a browser or by a link preview service
- THEN none of them carries an `og:` or `twitter:` tag

### A hidden or removed work has no card
- GIVEN a hidden work and a removed work
- WHEN each work page is fetched
- THEN the 451 and the 410 answers carry no card, and nothing about the work

### A card never carries a token
- GIVEN the sign-in page, the sign-in confirm page, the removal confirm page and the wait list confirm and unsubscribe pages, each with a token in its address
- WHEN each is fetched
- THEN none carries a card
- AND no `og:url` on any page holds a query

### A card's text is escaped
- GIVEN a work whose title, pseud, warning and fandom hold quotes and angle brackets
- WHEN its work page is fetched
- THEN every card tag's `content` ends at its own closing quote and holds no raw `<` or `"`
- AND the browser shows the text as plain text

### Before launch the coming-soon page has the site card
- GIVEN the site before launch
- WHEN a signed-out visitor fetches `/`
- THEN the coming-soon page carries the site card

### Admin and signed-in pages show no detail in a card
- GIVEN a signed-in moderator
- WHEN they fetch `/`, a work page, `/admin`, `/me/uploads` and `/settings/reader`
- THEN `/` and the work page carry the card a signed-out visitor gets, with no email or account detail, and the other pages carry no card

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
