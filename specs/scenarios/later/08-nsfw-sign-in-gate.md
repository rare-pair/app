# Scenario: NSFW works need sign-in to read

Relates to: docs/ARCHITECTURE.md § Decisions so far (Who can read uploads, NSFW works), § Reading (Caching, Warnings screen, NSFW sign-in gate, Download original epub), § Crawlers and agents, § Auth, § Connections; docs/FRONTEND-DISCOVERY.md § Decisions so far (JavaScript), § Who uses it, § Key journeys (1), § Page inventory (Warnings screen); specs/scenarios/mvp/01-auth-magic-link.md; specs/scenarios/mvp/09-content-origin.md; specs/scenarios/mvp/10-work-page.md; specs/scenarios/mvp/11-reader-and-csp.md; specs/scenarios/mvp/12-warnings-interstitial.md; specs/scenarios/mvp/21-accessibility-and-no-js.md; specs/scenarios/mvp/24-crawler-and-agent-blocking.md; specs/scenarios/later/07-email-failover.md

Operator ruling, 2026-11-06: NSFW works need no gate at launch. One follows soon after, using the existing email magic-link sign-in. This narrows the ruling of 2026-11-04 that ruled out a sign-in to read: every other work stays readable by everyone.

Status: not built. Until this ships, reading needs no account and no JavaScript, and the specs in `mvp/` describe the site. When it ships, specs 10, 11, 12, 21 and 24 change where the cases below say so, and spec 09 does only if decision 4 goes another way.

What this does and does not do: the gate asks a reader for a working email address before they read an NSFW work. It does not check anyone's age, since an email address says nothing about age, and no page may claim it does. It does not recall anything already out: a saved page, a downloaded epub, or a file URL someone kept from before the gate.

## Decisions for the operator

The cases below are written to the recommendation in each row. A different ruling changes only the cases named.

| # | Decision | Recommendation | Other choices, and what they cost | Cases it changes |
| --- | --- | --- | --- | --- |
| 1 | Which ratings count as NSFW | Everything but General Audiences and Teen And Up Audiences: Mature, Explicit, Not Rated and any rating we don't recognise. This matches how the warnings screen reads a rating, and the code can share that list. A work with no rating could be anything, so it fails closed | Mature and Explicit only: Not Rated works stay open, some of which are explicit. Explicit only: the narrowest gate, and Mature works with sexual content stay open. The recommendation's cost: Mature includes works that are only violent, and Not Rated includes many harmless works, and all of those readers meet the gate | "Which works are gated" |
| 2 | Whether an archive warning alone gates a work | No. The gate follows the rating alone, and a General or Teen work with a warning keeps only its warnings screen | Gate some warnings, such as "Underage" or "Rape/Non-Con", on any rating: closer to some readers' idea of NSFW, and a second list to keep | "Which works are gated" |
| 3 | What stays public about a gated work | Everything but its text: card, work page, summary, tags, chapter titles, listings and search. Rating and warnings must show on every card (FRONTEND-DISCOVERY, *Warnings*), and a reader can't decide to sign in for a work they can't see | Hide the summary, and chapter titles, from signed-out visitors, since either can hold explicit wording: the work page gets a second form, and search still matches on the summary, so a query would show a work for words its card leaves out. Leave gated works out of signed-out listings and search: a much larger change, and shared links stop explaining themselves | "Work page", "Listings and search" |
| 4 | Originals on the content origin | Hide the link and leave the content Worker as it is. A signed-out visitor is never handed the URL, as with images. A URL already out keeps working until the work is removed, including every one shown publicly between launch and the gate | **Signed links:** the app mints a short-lived link for a signed-in reader, and the content Worker refuses a bare URL, which ends the URLs already out. It takes a secret in two Workers and changes spec 09's rule that a query string is a 404, and every original needs one, whatever its rating, since a cache hit reads no rating. **Serve from the app:** a session-aware `/works/:id/original`, as an attachment. It moves fic bytes onto the app origin, which the content origin exists to avoid, and they lose the 12-hour edge cache | "Originals" |
| 5 | Images | Leave them ungated. Their URLs hold a hash of the bytes and can only be learned from gated text, and signing them would break the one fragment every reader shares. A signed-in reader can pass on an image's URL, and it works for anyone | Rewrite image URLs per response with a signature: every chapter read costs more, and the edge copy of a fragment stops being servable as it is | "Images" |
| 6 | An age statement | None: no checkbox and no stored claim. The gate's copy says the rating and asks for sign-in, and no page says we check ages | A line in `/welcome/terms` saying the reader is an adult. It reaches new accounts only, unless existing accounts are asked again, and it checks nothing | "The screen for a signed-out visitor", "Sign-in journey" |
| 7 | Saved reading position on gated works | Keep saving it, and say so on the privacy page. Everyone reading a gated work now has an account, so `pos:<user id>:<AO3 work id>` becomes a record of the NSFW works that account read. It lasts a year or until the account is deleted | Don't save position on gated works: no such record, and the feature stops for those readers | "Privacy" |
| 8 | The work ID in the sign-in email | Accept it. The link already carries `next` (`apps/web/src/auth.ts`), so a reader stopped at a gated work gets an email whose link names that work, and the email queue and Resend carry it too. Say so on the privacy page | Send the link with `next` set to `/` for a gated page: the reader's inbox stays clean, and they land on the home page and have to find the work again. Hold `next` on the server instead: a new table | "Sign-in journey", "Privacy" |
| 9 | When it goes on | The operator turns it on by hand with a Worker setting, after the checks under "Before turning it on". The code can ship with the setting off | Tie it to a date, or to the launch email's send finishing | "Turning it on" |

Accepted unless the operator says otherwise, each a direct cost of using this sign-in:

- **JavaScript.** Asking for a sign-in link needs Turnstile, so a browser with JavaScript off can't ask for one, and FRONTEND-DISCOVERY's "reading works fully with JavaScript off" stops being true of gated works. Such a reader can ask from another browser and open the link in this one, since the confirm page's button needs no script.
- **Email.** While Resend is down, or an address has spent its 5 emails for the UTC day, a signed-out reader can't start reading a gated work (specs/scenarios/later/07-email-failover.md). Anyone already signed in keeps reading.
- **Database faults.** A signed-in request whose session lookup fails answers 500, so during a Postgres outage gated works are unreadable to everyone, while a signed-out reader can still get an ungated chapter from the edge cache for the rest of its 60 s.

## Before turning it on

- Measure signed-in reads under load. Today a signed-in chapter read never uses the page entry, so it takes a session read on the uncached Hyperdrive config plus the work read on the cached one, and every read of a gated work becomes one of these. If that is too much for Neon's connections, the next step is to let signed-in readers use the page entry, deciding the warnings screen from `warnings_off` per request. That changes "A signed-in reader never uses the page entry" below, and the header stays per response either way.
- Check Resend's plan against one sign-in email per new reader. The gate turns readers who would never have made an account into sign-ins, on the path that shares its sending reputation with every other sign-in.
- Update `/privacy` as "Privacy" says. The operator proofs the draft copy.
- The change that adds the gate sets `NSFW_GATE = "off"` in the web Worker's `wrangler` config in the same PR. A missing setting means on, so without it the first deploy gates at once.

## Setup

- `NSFW_GATE` is a setting on the web Worker. The gate is on unless it says `off`, the same reading as `PRELAUNCH`, so a typo can't open it. Every case but those under "Turning it on" has it on, and `PRELAUNCH` off
- Live works, each with 5 chapters:
  - E rated Explicit
  - M rated Mature
  - U with no rating (its version has the `missing_rating` review reason), shown as "Not Rated"
  - R whose rating is the text "Not Rated"
  - Q whose rating is a string we don't recognise
  - T rated Teen And Up with the archive warning "Graphic Depictions Of Violence"
  - G rated General Audiences with no archive warnings
- A **gated work** is a work whose rating isn't General Audiences or Teen And Up Audiences, after trimming and ignoring case
- A signed-out visitor, with no session or with one that has ended. A signed-in reader who has accepted the terms
- Draft copy is for the operator to proof

## Cases

### Which works are gated

#### Mature, Explicit, Not Rated and unknown ratings are gated
- GIVEN works E, M, U, R and Q and a signed-out visitor
- WHEN they open chapter 1 of each
- THEN each answers the redirect in "A signed-out visitor is stopped before any text"

#### General and Teen works are not gated, warnings or not
- GIVEN works G and T and a signed-out visitor
- WHEN they open chapter 1 of each
- THEN G opens directly, and T shows its warnings screen with its working Continue, both as in spec 12

### Reading pages

#### A signed-out visitor is stopped before any text
- GIVEN gated work E and a signed-out visitor
- WHEN they send a GET or HEAD for `/works/:id/chapters/3` or `/works/:id/full`
- THEN the response is a 302 to `/works/:id/warnings?next=<the page asked for>` with `Cache-Control: private, no-store`
- AND no chapter text is in it, and no fragment is read from R2 or the cache

#### The gate can't be passed with the warnings cookie
- GIVEN a signed-out visitor whose `__Host-warned` cookie lists E, from continuing past its screen before the gate or while signed in
- WHEN they open chapter 2 of E
- THEN they get the same redirect

#### The chapter select leads to the same gate
- GIVEN gated work E and a signed-out visitor
- WHEN they open `/works/:id/chapters?n=3`
- THEN they get the 303 to chapter 3 as today, and chapter 3 answers the redirect

#### A chapter number gives nothing away
- GIVEN gated work E, with 5 chapters, and a signed-out visitor
- WHEN they open chapter 3, chapter 6 and `/works/:id/chapters/abc`
- THEN all three answer the redirect, so the chapter count comes only from the work page, and `next` for the last is this work's chapter 1, as Continue's rule has it

#### Hidden and removed works answer as they do today
- GIVEN gated work E hidden, and gated work M removed, with no page entry
- WHEN a signed-out visitor opens a chapter or `/full` of each
- THEN E answers 451 and M answers 410, with no redirect
- AND where a page entry from before the hide is still standing, the redirect goes to the warnings URL, which itself answers 451 or 410, so no text is served either way

#### Refusals and throttles keep their place
- GIVEN a declared automated client, a cross-site subresource request, and a visitor over the read throttle
- WHEN each asks for a chapter of E
- THEN each gets the same 403 or 429 as in spec 24, before the session or the gate
- AND a redirect from the gate counts as one read, as the redirect to the warnings screen does

#### A signed-in reader reads as today
- GIVEN gated work E and a signed-in reader
- WHEN they open a chapter or `/full`
- THEN they get E's warnings screen unless they have seen it this session or have `warnings_off`, and then the page, as in spec 12

#### An account that hasn't accepted the terms goes to the terms
- GIVEN gated work E and a session whose account hasn't accepted the terms
- WHEN they open a chapter
- THEN the terms gate sends them to `/welcome/terms` carrying the page, as for any page

#### An ended session is signed out
- GIVEN gated work E and a visitor with an expired or deleted session's cookie, the sessions of a deleted account included
- WHEN they open a chapter
- THEN they get the redirect

#### Signing out shuts the gate again
- GIVEN a reader of E who signs out, with a chapter of E open in another tab
- WHEN that tab reloads
- THEN it gets the redirect, whatever the `__Host-warned` cookie lists

### The screen for a signed-out visitor

The warnings screen keeps one URL and one template, so a shared link explains itself instead of landing on a bare email form.

#### The screen says why and offers sign-in
- GIVEN gated work E and a signed-out visitor on `/works/:id/warnings?next=/works/:id/chapters/3`
- WHEN it renders
- THEN it shows E's title, rating and archive warnings, as today
- AND in place of Continue a link "Sign in to read this work" goes to `/login?next=/works/:id/chapters/3`
- AND a link goes back to the work page
- AND there is no Continue button, no turn-off checkbox and no sentence about ages
- AND it has `Cache-Control: private, no-store`

#### `next` stays this work's
- GIVEN any `next` on that URL other than this work's chapter or `/full`
- WHEN the screen renders
- THEN the sign-in link carries this work's chapter 1, as Continue's rule has it

#### A POST to the screen opens nothing
- GIVEN a signed-out visitor on an old tab of E's warnings screen, with its Continue form
- WHEN they submit it
- THEN they are redirected to the page asked for, and that page answers the redirect back to the screen
- AND no text is served

#### The screen says what sign-in needs with JavaScript off
- GIVEN a signed-out visitor with JavaScript off, on E's screen
- WHEN it renders
- THEN it renders fully, and a `<noscript>` line says that asking for a sign-in link needs JavaScript

#### The screen works for a work that isn't gated, as today
- GIVEN work T and a signed-out visitor on its warnings screen
- WHEN it renders
- THEN it has Continue as in spec 12, and no sign-in link

### Sign-in journey

#### From the home page to the chapter
- GIVEN a signed-out visitor, with an existing account that has accepted the terms, on the home page
- WHEN they follow links to gated work E's listing, its work page and chapter 1, then the sign-in link, then ask for a link and open it in the same browser
- THEN they land on chapter 1's warnings screen and, after Continue, on chapter 1
- AND a browser journey covers this, starting at home

#### `warnings_off` goes straight to the chapter
- GIVEN the same visitor, whose account has `warnings_off`
- WHEN they open the link
- THEN they land on chapter 1 with no screen

#### A new account accepts the terms first
- GIVEN a visitor with no account
- WHEN they open the link
- THEN they accept the terms, and continue to the warnings screen and chapter 1, as in spec 01

#### A shared link to a later chapter comes back to that chapter
- GIVEN a signed-out visitor who opened a shared link to chapter 3 of E
- WHEN they sign in
- THEN they end on chapter 3, not chapter 1

#### The sign-in email names the work only in its link
- GIVEN a visitor stopped at gated work E who asks for a sign-in link
- WHEN the email is sent
- THEN its link's `next` holds the page asked for, as today
- AND the email's subject and text don't name the work, its rating or that it is NSFW

### Edge-cached chapter pages

Only signed-out requests with no settings, flash or auth cookie read or fill the page entry (`pageCacheable`, spec 11), and the gate runs before anything is served on a hit, as the warnings screen does today.

#### A hit is gated with no database read
- GIVEN a page entry for chapter 2 of gated work E, and a signed-out visitor with no cookies
- WHEN they open chapter 2
- THEN they get the redirect, decided from what the entry kept, with no database read and no R2 or fragment cache read

#### A miss stores what the next visitor needs
- GIVEN no page entry for chapter 2 of E, and a signed-out visitor with no cookies
- WHEN they open chapter 2
- THEN the work is read once, and the page entry is stored marked gated for its usual 60 s, with the work's Cache-Tag, though this visitor gets the redirect
- AND no fragment is read to do it
- AND so a shared link to a gated chapter costs one work read a minute per data centre, however many signed-out visitors follow it

#### An entry holds no text
- GIVEN a stored page entry for a gated work
- WHEN it is read back
- THEN it holds what any entry holds, the page's chrome and its fragment's key, and no chapter text, as in `ChapterPage`

#### An entry from before the gate is a miss
- GIVEN a page entry stored by a deploy from before the gated mark
- WHEN the new deploy reads it
- THEN it is a miss, since the page format was raised with the new field, so an entry with no mark can never serve text

#### A visitor with a settings cookie is gated too
- GIVEN gated work E, and a signed-out visitor with a settings cookie, so the entry is neither read nor filled
- WHEN they open a chapter
- THEN the work is read and they get the redirect

#### A signed-in reader never uses the page entry
- GIVEN a page entry for chapter 2 of E, stored for a signed-out visitor
- WHEN a signed-in reader opens chapter 2
- THEN the page is built from the database as today, and the entry is neither read nor written
- AND their response has `Cache-Control: private, no-store`

#### The fragment cache stays shared
- GIVEN a signed-in reader's read of chapter 2 of E, which put its fragment in the Worker's cache
- WHEN a signed-out visitor opens chapter 2
- THEN they get the redirect, and no route serves that fragment's key
- AND a later signed-in reader gets the identical fragment from the cache

#### An ungated page is cached as before
- GIVEN work G and signed-out visitors with no cookies
- WHEN they open chapter 2
- THEN the page is served and kept at the edge for 60 s as in spec 11
- AND work T's entry still sends a visitor who hasn't seen its screen to the warnings screen, with its Continue

#### A removal still purges the entry
- GIVEN a page entry for a gated work
- WHEN the work is removed
- THEN the purge by the work's Cache-Tag takes it

#### A rating change shows within the usual window
- GIVEN work T with a page entry, and a new version going live that rates it Explicit
- WHEN a signed-out visitor opens the chapter
- THEN the page may still open from the old entry, or from a read on the cached connection, for up to about 135 s: nothing purges on a new version, and this is the window in ARCHITECTURE, *Caching*. Accepted
- AND after it, they get the redirect

#### A lowered rating doesn't trap the reader
- GIVEN gated work E with a page entry, and a new version going live that rates it General Audiences
- WHEN a signed-out visitor opens the chapter inside the entry's 60 s
- THEN the entry can still say gated while the warnings screen, reading the new rating, sends them back to the chapter, so the browser can report too many redirects until the entry lapses
- AND that lasts at most 60 s, needs a rating to drop in that minute, and shows no text it shouldn't. Accepted, like the other windows in ARCHITECTURE, *Caching*
- AND after it, the chapter opens

### Work page

#### The work page stays public
- GIVEN gated work E and a signed-out visitor
- WHEN they open `/works/:id`
- THEN it renders as in spec 10: title, byline, rating, warnings, tags, full summary, stats and chapter list, with the same link card, which has no summary
- AND one line near the chapter list says "Sign in to read this work", linking to `/login?next=/works/:id`
- AND the chapter links stay, and answer the redirect

#### The report and removal links don't change
- GIVEN gated work E and a signed-out visitor on its work page
- WHEN they follow "Remove my work" or the report link
- THEN each behaves as in spec 10, so an author with no account can still ask for their work's removal

#### A signed-in reader sees today's page
- GIVEN gated work E and a signed-in reader
- WHEN they open `/works/:id`
- THEN it has no sign-in line, and has the download link and any "Continue where you left off" link, as in spec 10

### Originals

The content origin keeps no session and takes no cookie (spec 09), and that doesn't change: the session cookie has no `Domain`, and giving it one would hand it to the host that serves epub bytes as they are. So the app decides who is given the link. That holds up only because an original's URL can't be guessed: its key is the upload's id, from `crypto.randomUUID()`.

#### A signed-out visitor is not given the link
- GIVEN gated work E and a signed-out visitor
- WHEN they open `/works/:id`
- THEN there is no "Download original epub" link, and in its place "Sign in to download the original epub" links to `/login?next=/works/:id`
- AND the upload's id appears nowhere in the page's HTML

#### A signed-in reader is
- GIVEN gated work E and a signed-in reader
- WHEN they open `/works/:id`
- THEN the "Download original epub" link is there as in spec 10

#### An ungated work's link is unchanged
- GIVEN work G and a signed-out visitor
- WHEN they open `/works/:id`
- THEN the "Download original epub" link is there as in spec 10

#### A URL already out still works
- GIVEN the original of gated work E, whose URL a visitor has from before the gate or from a signed-in reader
- WHEN a signed-out visitor requests it on `content.rarepair.fans`
- THEN it is served as in spec 09, with its throttle: the content Worker doesn't know who is asking, or the rating. Accepted, decision 4

#### The content Worker doesn't change
- GIVEN the content Worker
- WHEN this ships
- THEN it reads no cookie and no rating, sets no cookie, and its cache, its refusals (451, 404, 503) and spec 09 are all as they were

### Images

#### A gated work's images are served, and only gated text names them
- GIVEN an image in a chapter of gated work E
- WHEN a signed-in reader opens the chapter
- THEN the image loads from `content.rarepair.fans` with no cookie on the request, as in spec 09

#### A signed-out visitor is given no chapter's image URL
- GIVEN gated work E and a signed-out visitor
- WHEN they open its work page, warnings screen and a refused chapter
- THEN none of those responses holds the URL of an image from a chapter
- AND an image the sanitizer kept in the summary itself is public with the summary (decision 3), so the build checks whether a summary can hold one and, if it can, a gated work's work page shows the summary without it

#### An image URL someone passes on works
- GIVEN an image URL of gated work E, passed on by a signed-in reader
- WHEN a signed-out visitor requests it
- THEN it is served as in spec 09. Accepted, decision 5

### Listings and search

#### Gated works stay listed
- GIVEN gated work E in fandom F, and a signed-out visitor
- WHEN they open the home page, F's tag listing, or a listing filtered to Explicit
- THEN E's card is there with its rating and archive warnings in full, as in spec 14, and no sign-in wording is added to the card

#### Gated works stay searchable
- GIVEN gated work E and a signed-out visitor
- WHEN they search for its title, author, a tag or a word in its summary
- THEN E's card is in the results, as in spec 15
- AND search still reads metadata only

#### Listings can't go stale on who is signed in
- GIVEN a tag listing kept by the browser for up to two minutes
- WHEN a reader signs in during that time
- THEN the listing may show the signed-out header, as already accepted, and its cards are the same either way, so the gate adds nothing that can go stale there

### Privacy

#### The gate keeps no record of what was stopped
- GIVEN a signed-out visitor stopped at gated work E, and a signed-in reader reading it
- WHEN the requests are handled
- THEN no new row, key or log line records who asked for which work, apart from the saved reading position that already exists, and error logs keep to an error's class name

#### The privacy page says what signing in to read means
- GIVEN `/privacy`
- WHEN the gate is on
- THEN it says that NSFW works need an account, that saved position records which works an account read until it expires or the account is deleted, that a sign-in link can name the work the reader was on, and how to ask for an account's deletion

#### No page claims an age check
- GIVEN the warnings screen, `/about`, `/terms` and `/privacy`
- WHEN each is read
- THEN none says or implies the site checks a reader's age

### Turning it on

#### Off, the site is as `mvp/` describes
- GIVEN `NSFW_GATE` is `off`
- WHEN a signed-out visitor opens E's chapters, `/full`, warnings screen and work page
- THEN all of them behave as in specs 10, 11 and 12, and the download link is there

#### Any other value is on
- GIVEN `NSFW_GATE` is missing or misspelt
- WHEN a signed-out visitor opens a chapter of E
- THEN they get the redirect

#### Entries are marked whether or not the gate is on
- GIVEN the deploy with the gated mark, with `NSFW_GATE` off, and page entries stored while it is off
- WHEN the setting is turned on
- THEN those entries gate at once, so turning it on opens no window beyond the deploy that applies the setting

#### Turning it off undoes it
- GIVEN the gate is on and accounts were made because of it
- WHEN `NSFW_GATE` is set to `off`
- THEN gated works read as they did, and nothing about the accounts changes
