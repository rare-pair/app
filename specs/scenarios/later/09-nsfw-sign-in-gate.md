# Scenario: NSFW works need sign-in and an age statement

Relates to: docs/ARCHITECTURE.md § Decisions so far (Who can read uploads, NSFW works), § Why these pieces (Hosts), § Reading (Caching, Warnings screen, NSFW gate, Download original epub), § Crawlers and agents, § Auth, § Connections; docs/FRONTEND-DISCOVERY.md § Decisions so far (JavaScript, NSFW works), § Who uses it, § Key journeys (1), § Page inventory (Warnings screen); specs/scenarios/mvp/01-auth-magic-link.md; specs/scenarios/mvp/09-content-origin.md; specs/scenarios/mvp/10-work-page.md; specs/scenarios/mvp/11-reader-and-csp.md; specs/scenarios/mvp/12-warnings-interstitial.md; specs/scenarios/mvp/21-accessibility-and-no-js.md; specs/scenarios/mvp/24-crawler-and-agent-blocking.md; specs/scenarios/later/07-email-failover.md

Operator rulings, 2026-11-06:
- NSFW works need no gate at launch. One follows soon after, using the existing email magic-link sign-in. This narrows the ruling of 2026-11-04 that ruled out a sign-in to read: every other work stays readable by everyone.
- A work is gated if it is rated Mature or Explicit, or carries the archive warning Rape/Non-Con or Underage, on any rating. Not Rated works, unknown ratings and every other warning stay open, and keep their warnings screen.
- A gated work's text, originals and images are all gated, on the content origin too.
- On top of signing in, a reader ticks an age statement. A cookie remembers it, so the box isn't asked again in that browser.
- Everything but a gated work's text and images stays public: card, work page, summary, tags, chapter titles, listings and search.
- Reading position isn't saved on gated works, so an account holds no record of which ones it read.
- A sign-in link asked for from a gated work goes to the home page, so the email, the queue and Resend hold no work ID. The reader finds the work again after signing in.
- The operator turns the gate on by hand, after the checks under "Before turning it on". The code ships with it off.
- A reader can report a work as NSFW. Reports from 3 distinct accounts gate it at once, and a moderator then confirms or clears that. The reason ships with the gate and shows only while the gate is on.

Status: not built. Until this ships, reading needs no account and no JavaScript, and the specs in `mvp/` describe the site. When it ships, specs 09, 10, 11, 12, 14, 15, 17, 18, 21 and 24 change where the cases below say so.

What this does and does not do: the gate asks for a working email address and a reader's own word about their age. It checks nothing about their age. It does not recall a saved page, a downloaded epub or a copy already in a browser's cache.

## Defaults and accepted costs

Defaults taken where the rulings left a detail open, which the operator can change in a word:

- The statement's wording, draft: "I am 18 or older." The age is the draft's, not a ruling.
- The age cookie lasts a year in that browser. Signing out clears it, so the next person on a shared browser is asked. A session that just ends doesn't clear it.
- It is kept in the cookie alone, as ruled: nothing about age goes on the account, so another browser or device asks again.
- The report link keeps its `next`, since `requireSignIn` runs before any work is read. A signed-out visitor who reports a gated work gets a sign-in link naming it. Reporting is their own choice, and it needs no gate.
- Positions saved before the gate, or before a work became gated, aren't deleted. Nothing reads them while the work is gated, and they expire within a year or go with the account. If a rating is later lowered, the Continue link comes back.
- An NSFW mark belongs to the work, not a version, so a new version or a rollback keeps it. Without that, an upload could undo a moderator's decision.
- A moderator's "Not NSFW" can't open a work that its rating or warnings gate. It lifts only the mark, so 3 new reports can gate the work again. Making it stick is backlogged in specs/scenarios/later/10-nsfw-clear-sticks.md.

Accepted unless the operator says otherwise, each a direct cost of using this sign-in:

- **JavaScript.** The gate itself needs none: the warnings screen and the age box are plain pages and forms. Only asking for a sign-in link does, because `/login` has a Turnstile check, which keeps the form from being used to mail strangers, and Turnstile can't produce a token without a script. So FRONTEND-DISCOVERY's "reading works fully with JavaScript off" stops being true of gated works for a reader with no session. Such a reader can ask from another browser and open the link in this one, since the confirm page's button needs no script.
- **Email.** While Resend is down, or an address has spent its 5 emails for the UTC day, a signed-out reader can't start reading a gated work (specs/scenarios/later/07-email-failover.md). Anyone already signed in keeps reading.
- **Database faults.** A signed-in request whose session lookup fails answers 500, so during a Postgres outage gated chapters are unreadable to everyone, while a signed-out reader can still get an ungated chapter from the edge cache for the rest of its 60 s.
- **A raised rating on a cached file.** A new version doesn't purge the content origin's cache, so a file stored as ungated stays open in that data centre for up to 12 hours after its work becomes gated, and in a browser for an hour after that. It is the same window a hide has (spec 09).
- **A pass can be passed on.** A signed-in reader who copies their pass cookie can hand someone a day's access to every gated file, and a copied file URL needs a pass of its own. Reading the text was always copyable by the same person.
- **False reports.** Three accounts can put a harmless work behind sign-in until a moderator clears it. It stays readable after sign-in, and accounts are free to make, so this limits abuse only as far as the 3-account hide does.

## How the content origin gates without a session

The session cookie has no `Domain` and never reaches `content.rarepair.fans`, and that doesn't change: it is the point of keeping a separate host for bytes served as they are. The app instead gives a reader who has passed the gate a **reader pass**, which proves only that:

- `__Secure-reader-pass`, set by the web Worker with `Domain=rarepair.fans; Path=/; Secure; HttpOnly; SameSite=Lax` and a 24-hour `Max-Age`. A `__Host-` name can't carry a `Domain`.
- Its value is `<expiry>.<signature>`: an expiry time and an HMAC of it under `READER_PASS_KEY`, a secret both Workers hold. It holds no user id, session or work, so the content origin learns nothing about who is asking and logs nothing new.
- The content Worker checks it with no database read. It still sets no cookie.
- Because a chapter's `<img>` and a download link are same-site requests, the browser sends it with no change to fragments or URLs. A cross-site `<img>` doesn't send it, so another site can't embed a gated image.

Rejected: a signature in each image URL breaks the one fragment every reader shares. Serving gated files from the app puts them on the host the content origin exists to keep them off, and loses the 12-hour cache. A `Domain` on the session cookie hands the session to that host.

## Before turning it on

- Measure signed-in reads under load. Today a signed-in chapter read never uses the page entry, so it takes a session read on the uncached Hyperdrive config plus the work read on the cached one, and every read of a gated work becomes one of these. If that is too much for Neon's connections, the next step is to let signed-in readers use the page entry, deciding the screen per request. That changes "A signed-in reader never uses the page entry" below, and the header stays per response either way.
- Check Resend's plan against one sign-in email per new reader. The gate turns readers who would never have made an account into sign-ins, on the path that shares its sending reputation with every other sign-in.
- Set `READER_PASS_KEY` on both Workers.
- Update `/privacy` as "Privacy" says. The operator proofs the draft copy.
- The change that adds the gate sets `NSFW_GATE = "off"` in both Workers' `wrangler` config in the same PR. A missing setting means on, so without it the first deploy gates at once.

## Setup

- `NSFW_GATE` is a setting on the web and content Workers. The gate is on unless it says `off`, the same reading as `PRELAUNCH`, so a typo can't open it. Every case but those under "Turning it on" has it on, and `PRELAUNCH` off
- A **gated work** is a work rated Mature or Explicit, after trimming and ignoring case, or carrying the archive warning Rape/Non-Con or Underage, compared in their normalized form, or holding an NSFW mark of `reported` or `confirmed`. AO3 has also spelled the second warning "Underage Sex", and the list holds both
- A work's **NSFW mark** is a column on `works`: none, `reported` (3 accounts reported it) or `confirmed` (a moderator marked it)
- Live works, each with 5 chapters and an image:
  - E rated Explicit
  - M rated Mature
  - A rated General Audiences with the archive warning Underage
  - N rated Teen And Up with the archive warning Rape/Non-Con
  - T rated Teen And Up with the archive warning "Graphic Depictions Of Violence"
  - C rated Teen And Up marked "Choose Not To Use Archive Warnings"
  - U with no rating (its version has the `missing_rating` review reason), shown as "Not Rated"
  - R whose rating is the text "Not Rated"
  - Q whose rating is a string we don't recognise
  - G rated General Audiences with no archive warnings
- A signed-out visitor, with no session or with one that has ended. A signed-in reader who has accepted the terms, with or without the age cookie
- The **age cookie** is `__Host-age-confirmed`, fixed value, `Path=/; Secure; HttpOnly; SameSite=Lax`, one year. It says only that this browser's reader ticked the box. Forging it skips only a box anyone could tick, and it never stands in for a session
- Draft copy is for the operator to proof

## Cases

### Which works are gated

#### Mature and Explicit works are gated
- GIVEN works E and M and a signed-out visitor
- WHEN they open chapter 1 of each
- THEN each answers the redirect in "A signed-out visitor is stopped before any text"

#### Rape/Non-Con and Underage gate a work on any rating
- GIVEN works A and N and a signed-out visitor
- WHEN they open chapter 1 of each
- THEN each answers the same redirect

#### Other warnings, and no rating, are not gated
- GIVEN works T, C, U, R and Q and a signed-out visitor
- WHEN they open chapter 1 of each
- THEN each shows its warnings screen with its working Continue, as in spec 12

#### A general work with no warnings is not gated
- GIVEN work G and a signed-out visitor
- WHEN they open chapter 1
- THEN it opens directly

### Reading pages

#### A signed-out visitor is stopped before any text
- GIVEN gated work E and a signed-out visitor
- WHEN they send a GET or HEAD for `/works/:id/chapters/3` or `/works/:id/full`
- THEN the response is a 302 to `/works/:id/warnings?next=<the page asked for>` with `Cache-Control: private, no-store`
- AND no chapter text is in it, and no fragment is read from R2 or the cache

#### A signed-in reader without the age cookie is stopped the same way
- GIVEN gated work E and a signed-in reader with no age cookie, with `warnings_off` or not
- WHEN they open a chapter or `/full`
- THEN they get the same redirect, and no fragment is read

#### The gate can't be passed with the other cookies
- GIVEN a signed-out visitor holding an age cookie, a reader pass, and a `__Host-warned` cookie listing E
- WHEN they open chapter 2 of E
- THEN they get the redirect, since only a session opens the text

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

#### A reader past the gate reads as today
- GIVEN gated work E and a signed-in reader with the age cookie
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
- WHEN they sign out
- THEN the sign-out response clears the age cookie and the reader pass, as well as the session
- AND when the tab reloads it gets the redirect, whatever the `__Host-warned` cookie lists

### The warnings screen on a gated work

The warnings screen keeps one URL and one template, so a shared link explains itself instead of landing on a bare email form.

#### Signed out, the screen offers sign-in
- GIVEN gated work E and a signed-out visitor on `/works/:id/warnings?next=/works/:id/chapters/3`
- WHEN it renders
- THEN it shows E's title, rating and archive warnings, as today
- AND in place of Continue a link "Sign in to read this work" goes to `/login`, with no `next` naming this work
- AND a line says that signing in leads to the home page, so the reader will need to find this work again
- AND a link goes back to the work page
- AND there is no Continue button, no age box and no turn-off checkbox
- AND it has `Cache-Control: private, no-store`

#### Signed in without the age cookie, the screen asks for the statement
- GIVEN gated work E and a signed-in reader with no age cookie
- WHEN the screen renders
- THEN it shows the title, rating and warnings, a checkbox labelled "I am 18 or older", and Continue, as a POST form
- AND the turn-off checkbox as in spec 12
- AND a link back to the work page
- AND it says this is the reader's own statement, and doesn't say or imply that anything is checked

#### Ticking the box opens the work
- GIVEN that screen
- WHEN the reader ticks the box and continues
- THEN the response sets the age cookie, the reader pass and the warned cookie for E, and goes to the page asked for with a 303

#### Not ticking the box opens nothing
- GIVEN that screen, with JavaScript on or off
- WHEN the reader continues without ticking the box
- THEN the server shows the screen again saying the box is needed, and sets no cookie
- AND turn-off, if ticked, isn't saved

#### The box isn't asked again in this browser
- GIVEN a signed-in reader with the age cookie, on any gated work's screen
- WHEN it renders
- THEN it has no age box, and Continue works as in spec 12

#### `warnings_off` doesn't skip the box
- GIVEN a signed-in reader with `warnings_off` and no age cookie
- WHEN they open a chapter of gated work E
- THEN they see the screen with the age box. With the cookie, the chapter opens directly

#### Another browser asks again
- GIVEN a reader who ticked the box on one device
- WHEN they sign in on another and open a gated work
- THEN they are asked again, since nothing about age is on the account

#### `next` stays this work's
- GIVEN any `next` on that URL other than this work's chapter, `/full` or work page
- WHEN the screen renders
- THEN Continue carries this work's chapter 1, as Continue's rule has it, and the sign-in link carries no `next` at all

#### A POST from a signed-out visitor opens nothing
- GIVEN a signed-out visitor on an old tab of E's warnings screen, with its Continue form and the box ticked
- WHEN they submit it
- THEN no age cookie or reader pass is set, the tick is ignored, and they are redirected to the page asked for, which answers the redirect back to the screen
- AND no text is served

#### The screen says what sign-in needs with JavaScript off
- GIVEN a signed-out visitor with JavaScript off, on E's screen
- WHEN it renders
- THEN it renders fully, and a `<noscript>` line says that asking for a sign-in link needs JavaScript

#### The age box needs no JavaScript
- GIVEN a signed-in reader with JavaScript off, on E's screen
- WHEN they tick the box and continue
- THEN the chapter opens

#### The screen works for a work that isn't gated, as today
- GIVEN work T and a signed-out visitor on its warnings screen
- WHEN it renders
- THEN it has Continue as in spec 12, with no sign-in link and no age box

### Sign-in journey

#### From the home page to the chapter
- GIVEN a signed-out visitor, with an existing account that has accepted the terms, on the home page
- WHEN they follow links to gated work E's listing, its work page and chapter 1, then the sign-in link, then ask for a link and open it in the same browser
- THEN they land on the home page, signed in
- AND when they find E again and open chapter 1, they get the warnings screen with the age box and, after ticking it and Continue, chapter 1, with its images loaded
- AND a browser journey covers this, starting at home

#### A new account accepts the terms first
- GIVEN a visitor with no account
- WHEN they open the link
- THEN they accept the terms, and continue to the home page, as in spec 01

#### A shared link needs following again
- GIVEN a signed-out visitor who opened a shared link to chapter 3 of E and signed in
- WHEN they open the shared link again and tick the box
- THEN they end on chapter 3

#### The sign-in email holds no work ID
- GIVEN a visitor who follows a sign-in link from gated work E's warnings screen or work page, and asks for a sign-in link
- WHEN the email is sent
- THEN its link's `next` is `/`, and the queue message and the email hold no work ID
- AND the email's subject and text don't name the work, its rating or that it is NSFW

#### An ungated work still comes back to its page
- GIVEN a visitor sent to sign in from an ungated work's report form
- WHEN they sign in
- THEN they come back through `next` as in spec 01, as they do from any page but the gate's

### Edge-cached chapter pages

Only signed-out requests with no settings, flash or auth cookie read or fill the page entry (`pageCacheable`, spec 11), and the gate runs before anything is served on a hit, as the warnings screen does today. So a gated work's entry is only ever used to refuse.

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

#### A lowered rating doesn't trap the reader for long
- GIVEN gated work E with a page entry, and a new version going live that rates it General Audiences
- WHEN a signed-out visitor opens the chapter inside the entry's 60 s
- THEN the entry can still say gated while the warnings screen, reading the new rating, sends them back to the chapter, so the browser can report too many redirects until the entry lapses
- AND that lasts at most 60 s, needs a rating to drop in that minute, and shows no text it shouldn't. Accepted, like the other windows in ARCHITECTURE, *Caching*
- AND after it, the chapter opens

### Reader pass

#### A reader past the gate holds a pass
- GIVEN a signed-in reader with the age cookie and no reader pass, or one with under 12 hours left
- WHEN the web Worker answers a chapter, `/full` or the work page of a gated work
- THEN the response sets a fresh pass, so a chapter's images and a download on that page have one
- AND a response to anyone else sets none, and none is stored in a shared cache

#### A pass is checked with no database read
- GIVEN a request with a reader pass
- WHEN the content Worker checks it
- THEN an expired, malformed or wrongly signed pass is the same as none, and the check reads no database

#### A pass holds nothing about the reader
- GIVEN a reader pass
- WHEN its value is read
- THEN it holds an expiry and a signature, and no user, session, address or work

#### The session cookie still stays away
- GIVEN a signed-in reader's request to `content.rarepair.fans`
- WHEN it is sent
- THEN it carries the pass, and no session or age cookie

#### A missing key fails closed
- GIVEN the content Worker with `READER_PASS_KEY` unset
- WHEN a gated file is requested, with any pass
- THEN it is refused as if with none, and ungated files are served

### Images

#### A gated work's image needs a pass
- GIVEN an image of gated work E, in or out of the data centre's cache, and a request with no valid pass
- WHEN it is requested by GET, HEAD, with a `Range` header or with any conditional header
- THEN the response is 403 with no body, `Cache-Control: no-store` and `nosniff`, no `Set-Cookie`, and nothing is stored
- AND a URL from before the gate is refused the same way

#### A reader with a pass sees it
- GIVEN an image of gated work E and a request with a valid pass, on a hit and on a miss
- WHEN it is requested
- THEN it is served with no cookie set, and no session or database read on a hit
- AND its response has `Cache-Control: private, max-age=3600`, not `public`
- AND the stored entry keeps `public, max-age=43200` and the bare URL as its key, so spec 09's purge still names it

#### A stored entry says whether it is gated
- GIVEN a file stored in the data centre's cache
- WHEN the entry is written
- THEN it holds a mark saying whether its work was gated, which never reaches the browser
- AND an entry with no mark, stored before the gate, is a miss, so it is checked like any other

#### A marked entry is checked again for a request with no pass
- GIVEN an entry marked gated, whose work has since been lowered to General Audiences, and a request with no pass
- WHEN it is requested
- THEN the work is read, and the file is served, so a lowered rating doesn't leave a reader's images broken for 12 hours
- AND a request refused this way costs that read, as a 451 does today

#### An ungated work's image is as it was
- GIVEN an image of work G or T and a request with no pass
- WHEN it is requested
- THEN it is served as in spec 09, with `Cache-Control: public, max-age=3600`, and no pass is looked at

#### Refusals keep their order
- GIVEN a hidden gated work and a removed gated work, and a request with no pass
- WHEN a file of each is requested past the cache
- THEN the first answers 451 and the second 404, as in spec 09, before the pass is considered

#### Another site can't embed a gated image
- GIVEN a page on another site with an `<img>` of gated work E, viewed by a reader holding a pass
- WHEN the browser requests it
- THEN `SameSite=Lax` keeps the pass off the request, and it is refused

#### A summary's image doesn't appear on a gated work
- GIVEN gated work E whose summary holds an `<img>`, which the sanitizer's allowlist keeps
- WHEN its work page or card renders, for anyone
- THEN the image is left out, and the rest of the summary shows, so a public page names no gated image

#### Only gated pages name a gated image
- GIVEN gated work E and a signed-out visitor
- WHEN they open its work page, warnings screen and a refused chapter
- THEN none of those responses holds an image URL

### Originals

#### A gated work's original needs a pass
- GIVEN the original of gated work E, in or out of the data centre's cache, and a request with no valid pass
- WHEN it is requested by GET, HEAD, with a `Range` header or with any conditional header
- THEN the response is 403 with no body, `Cache-Control: no-store` and `nosniff`, no `Set-Cookie`, and nothing is stored
- AND a URL kept from before the gate, or copied from a signed-in reader, is refused the same way

#### A reader with a pass downloads it
- GIVEN the original of gated work E and a request with a valid pass
- WHEN it is requested
- THEN it is served as an attachment, as in spec 09, with `Cache-Control: private, max-age=3600`, and its throttle still applies
- AND a duplicate upload's original follows its work the same way

#### The work page offers what the reader can use
- GIVEN gated work E
- WHEN its work page renders
- THEN a signed-out visitor gets "Sign in to download the original epub", linking to `/login` with no `next` naming this work, and the upload's id appears nowhere in the page's HTML
- AND a signed-in reader with no age cookie gets "Confirm your age to download the original epub", linking to the warnings screen with `next=/works/:id`
- AND a reader with the age cookie gets the "Download original epub" link as in spec 10

#### An ungated work's link is unchanged
- GIVEN work G and a signed-out visitor
- WHEN they open `/works/:id`
- THEN the "Download original epub" link is there, and the original is served with no pass, as in spec 09

#### A pass that ran out on an open tab
- GIVEN a work page left open for over a day, whose pass has expired
- WHEN the reader follows the download link
- THEN it is refused, and reloading the page sets a fresh pass while the session and age cookie last

### Work page

#### The work page stays public
- GIVEN gated work E and a signed-out visitor
- WHEN they open `/works/:id`
- THEN it renders as in spec 10: title, byline, rating, warnings, tags, summary, stats and chapter list, with the same link card, which has no summary
- AND one line near the chapter list says "Sign in to read this work", linking to `/login` with no `next` naming this work
- AND the chapter links stay, and answer the redirect

#### The report and removal links don't change
- GIVEN gated work E and a signed-out visitor on its work page
- WHEN they follow "Remove my work" or the report link
- THEN each behaves as in spec 10, so an author with no account can still ask for their work's removal

#### A signed-in reader sees the page with no saved place
- GIVEN gated work E and a signed-in reader with the age cookie, with a position saved before E was gated
- WHEN they open `/works/:id`
- THEN it has no sign-in line, and has the download link as in spec 10
- AND it has no "Continue where you left off" link, and the position isn't read

### Reading position

#### A gated page saves no position
- GIVEN gated work E and a signed-in reader with JavaScript on
- WHEN they read a chapter or `/full` of E
- THEN the page has no position script, and nothing is written to `POSITIONS`

#### An ungated work saves as today
- GIVEN work T and a signed-in reader with JavaScript on
- WHEN they read a chapter
- THEN the position is saved and offered as in spec 13

#### The save endpoint doesn't change
- GIVEN the position endpoint, which reads no work
- WHEN this ships
- THEN it stays as it is, so it adds no database read to a save. A tab opened before a work became gated, or a request made by hand, can still save to the reader's own account, and nothing reads it while the work is gated. Accepted

### Listings and search

#### Gated works stay listed
- GIVEN gated work E in fandom F, and a signed-out visitor
- WHEN they open the home page, F's tag listing, or a listing filtered to Explicit
- THEN E's card is there with its rating and archive warnings in full, as in spec 14, and no sign-in wording is added to the card, whose only new line is "Marked NSFW" on a work with a mark

#### Gated works stay searchable
- GIVEN gated work E and a signed-out visitor
- WHEN they search for its title, author, a tag or a word in its summary
- THEN E's card is in the results, as in spec 15
- AND search still reads metadata only

#### Listings can't go stale on who is signed in
- GIVEN a tag listing kept by the browser for up to two minutes
- WHEN a reader signs in during that time
- THEN the listing may show the signed-out header, as already accepted, and its cards are the same either way, so the gate adds nothing that can go stale there

### NSFW reports

The reason sits on the existing report form, with its account, ban, block and closed-report rules (spec 17). Draft label: "This should be marked NSFW", stored as kind `nsfw`.

#### A signed-in reader can report an ungated work as NSFW
- GIVEN work G and signed-in reader U1 on its report form
- WHEN U1 submits the reason "This should be marked NSFW"
- THEN an open `nsfw` report is stored and listed in `/admin/reports`
- AND G stays open, and the confirmation page says moderators will look at it

#### A signed-out reader signs in first
- GIVEN work G and a signed-out reader
- WHEN they follow "Report" or POST a report
- THEN they are sent to sign in and brought back to the form, as in spec 17, since G isn't gated

#### A gated work doesn't offer the reason
- GIVEN gated work E, or a work with a `reported` or `confirmed` mark
- WHEN its report form renders
- THEN it has no NSFW reason, and a POST of that reason stores nothing and shows the form again

#### Reports from three accounts gate the work
- GIVEN work G with open `nsfw` reports from U1 and U2
- WHEN U3 submits one
- THEN G's mark becomes `reported` in the same transaction, one moderation log row records it, and G is gated
- AND the work's page entries and files are purged as a removal purges them, with nothing deleted, so the gate applies within the usual window of about 75 s for the cached connection
- AND a failed purge doesn't fail the report: a page entry lapses within 60 s and a stored file within 12 hours

#### Repeat reports count once, and some don't count
- GIVEN work G with open `nsfw` reports from U1 only
- WHEN U1 reports it again, and account K, matching a blocked requester, reports it
- THEN both are stored, and G's mark doesn't change
- AND a banned account's report isn't stored, and a closed report doesn't count, as in spec 17

#### NSFW reports never hide a work
- GIVEN work G with open `nsfw` reports from 3 accounts, and open other reports from 2 others
- WHEN the counts are taken
- THEN G stays live, because `nsfw` reports never count toward the 3-account hide, and other reports never count toward the NSFW mark

#### A marked work says why it is gated
- GIVEN work G rated General Audiences, with a `reported` mark
- WHEN its card, work page or warnings screen renders
- THEN its rating still reads "General Audiences"
- AND the card, work page and warnings screen each have the plain line "Marked NSFW"
- AND a `confirmed` mark reads the same, so no reader-facing page says who marked it

#### A marked work passes through the same gate
- GIVEN work G with a `reported` mark, which otherwise gets no warnings screen
- WHEN a signed-out visitor and a signed-in reader with no age cookie open chapter 1
- THEN each gets the warnings screen for a gated work, with the sign-in link and the age box in turn
- AND a signed-in reader with the age cookie goes straight to chapter 1, since G has nothing else to warn about

#### A mark gates images and originals
- GIVEN work G with a `reported` mark, and a request with no valid pass
- WHEN one of its images or its original is requested past the cache
- THEN it is refused with the 403, since the content Worker's read includes the mark

#### A moderator confirms
- GIVEN work G with a `reported` mark and open `nsfw` reports
- WHEN a moderator uses "Mark NSFW" on the report's detail page
- THEN the mark becomes `confirmed`, every open `nsfw` report on G is closed, and one moderation log row records it

#### A moderator clears
- GIVEN work G with a `reported` mark and open `nsfw` reports
- WHEN a moderator uses "Not NSFW"
- THEN the mark is lifted, every open `nsfw` report on G is closed, one moderation log row records it, and G is open again within the usual windows
- AND no purge is sent: a stored file marked gated is checked again for a request with no pass, as under "Images"

#### New reports can gate a cleared work again
- GIVEN work G whose mark a moderator lifted, so its earlier reports are closed and don't count
- WHEN three accounts report it again
- THEN it is gated again, as under "Reports from three accounts gate the work"

#### A moderator can act without a report
- GIVEN any live work, on its admin page
- WHEN a moderator uses "Mark NSFW", or "Not NSFW" on a marked work
- THEN the mark changes as above, purging as above when that gates the work, with one moderation log row
- AND "Not NSFW" on a work rated Explicit changes the mark only, and the page says the work stays gated by its rating or warnings

#### A mark outlives a version
- GIVEN work G with a `confirmed` mark
- WHEN a new version goes live, or a moderator makes an older version current
- THEN the mark stays as it was

#### While the gate is off
- GIVEN `NSFW_GATE` is `off`
- WHEN a report form renders
- THEN it has no NSFW reason, and a POST of that reason stores nothing
- AND marks and open `nsfw` reports are kept, and marks gate nothing, and show on no page, until the gate is on again

### Privacy

#### The gate keeps no record of what was stopped
- GIVEN a signed-out visitor stopped at gated work E, and a signed-in reader reading it
- WHEN the requests are handled
- THEN no new row, key or log line records who asked for which work, and error logs keep to an error's class name

#### The privacy page says what signing in to read means
- GIVEN `/privacy`
- WHEN the gate is on
- THEN it says that NSFW works need an account and an age statement, that the statement is kept in a cookie in that browser and not on the account, what the reader pass is and that it reaches `content.rarepair.fans`, that reading position isn't saved on NSFW works, and how to ask for an account's deletion

#### No page claims an age check
- GIVEN the warnings screen, `/about`, `/terms` and `/privacy`
- WHEN each is read
- THEN none says or implies the site verifies a reader's age

### Turning it on

#### Off, the site is as `mvp/` describes
- GIVEN `NSFW_GATE` is `off` on both Workers
- WHEN a signed-out visitor opens E's chapters, `/full`, warnings screen, work page, images and original
- THEN all of them behave as in specs 09, 10, 11 and 12, and the download link is there

#### Any other value is on
- GIVEN `NSFW_GATE` is missing or misspelt on a Worker
- WHEN a signed-out visitor asks that Worker for a chapter or a file of E
- THEN the web Worker answers the redirect, and the content Worker refuses

#### Entries are marked whether or not the gate is on
- GIVEN the deploy with the gated marks, with `NSFW_GATE` off, and page entries and files stored while it is off
- WHEN the setting is turned on
- THEN those entries gate at once, so turning it on opens no window beyond the deploy that applies the setting

#### The web Worker goes first
- GIVEN the gate is being turned on
- WHEN the operator sets it
- THEN the web Worker is turned on first and the content Worker straight after, so nobody past the gate meets a refused image for want of a pass
- AND a reader signed in before that gets the age box on their next gated page, and the pass with it
- AND turning it off goes the other way round

#### Turning it off undoes it
- GIVEN the gate is on and accounts were made because of it
- WHEN `NSFW_GATE` is set to `off` on both Workers
- THEN gated works read as they did, and nothing about the accounts changes
