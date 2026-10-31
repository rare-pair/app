# Frontend discovery

**Status: hypotheses.** No displaced readers have been interviewed yet. Everything
below is a starting position to test, not a finding. See *What to validate
first* at the end.

Companion to [ARCHITECTURE.md](ARCHITECTURE.md). Wireframes:
[Archive wireframes](https://claude.ai/artifact/AjSQBMAtrvPz4sdRbVxRdm). This is
a private canvas, so share it from its Share menu before sending it to anyone.
It has 9 clickable screens (home, search, work, warnings, reader, settings,
sign in, upload, remove my work) plus search and reader at 390 px. All works,
fandoms and pseuds in it are invented placeholders.

## Decisions so far

| Question | Decision |
| --- | --- |
| Visual direction | Modern and minimal. The identity is plain HTML with a strong typographic hierarchy: type, spacing and rules do the work, not boxes, shadows or imagery |
| Warnings | **Hard constraint:** rating and archive warnings show on every work card and work page. They are never collapsed, never behind a hover, and never hidden to save space. Minimalism applies to everything else |
| JavaScript | Reading, browsing, search and reader settings work fully with JavaScript off; small scripts only enhance them (settings without a reload, saving reading position). Forms with a Turnstile check (sign-in, upload, `/remove`, and the wait list before launch) need JavaScript, because Turnstile can't produce a token without it; with JS off they say so in a `<noscript>` message |
| Pagination | Server-side pages with real URLs. No infinite scroll |
| Branding | No AO3 or OTW name, symbols or styling in the UI. Ratings and warnings are text badges, not symbol icons (ARCHITECTURE, opening) |
| Author identity | No claims, no author accounts, no "my works". Removal and opt-out are a public request form that needs no sign-in (ARCHITECTURE, *Author requests & takedowns*) |
| Card summaries | Clamped to 3 lines with a "more" link to the work page, which shows the full summary. Rating and archive warnings are separate lines and are never clamped. A content note in summary line 4 is hidden on cards, and that's accepted |
| Home page | Leads with search. Popular fandoms and recently added works go below |
| Original AO3 link | A live link with a note that it works again once AO3 is back. Nothing changes automatically when AO3 returns; redirecting works to AO3 is part of a later wind-down the operator starts by hand |
| Discovery output | This doc plus low-fidelity clickable wireframes |
| Coming-soon typography | The coming-soon page and the other wait list pages are set in Fraunces, with IBM Plex Mono for labels and buttons. Both are self-hosted on `rarepair.fans` as their publishers' own woff2 files, unmodified, with their OFL licences beside them. They aren't subset or renamed internally by us, because IBM Plex's licence reserves the name "Plex". Only their file names are ours, content-hashed. Never a third-party font host. Every other page keeps the system stacks (*Typographic system*) |

## Principles

1. **Reading comes first.** The reader page is the product. Everything else gets
   people to it, or protects the people whose work it is.
2. **Text is the interface.** A clear type scale, generous line height and a
   readable line length (about 66 characters) carry the hierarchy. There is one
   accent colour, used for links and focus.
3. **Fast on a cheap phone on a bad connection.** Pages are server-rendered with
   no web fonts and tiny CSS. Most fanfic reading happens on phones.
4. **Honest about being temporary.** A slim banner on every page says this is an
   unofficial stopgap, and every work links to its original AO3 URL.
5. **Warnings are content, not chrome.** They're placed and styled like the title
   and author: plain, prominent, unmissable.

## Who uses it

| Role | Signed in? | What they come for |
| --- | --- | --- |
| Reader | No | Find a work they lost access to, or browse a fandom, and read it |
| Signed-in reader | Yes | The same, plus saved reading position and remembered settings |
| Uploader | Yes | Rescue works from their epub collection, then check they processed |
| Author | No | Get a work taken down, or opt out a pseud entirely. Updating a work is just an upload |
| Moderator | Yes, with the role | Work through reports, takedowns, removal or opt-out requests, and works to check |

Reading never requires an account (ARCHITECTURE, *Auth*).

## Key journeys

**1. Find and read a work** (reader)
1. They arrive at the home page from a link or search, or land on a work page
   from a shared URL.
2. They search by title or author, or open a fandom and narrow by rating, tags
   or completion.
3. The results are a list of work cards, each with rating and warnings visible.
4. They open the work page: summary, tags, stats, chapter list, original AO3
   link.
5. For works rated Mature or Explicit, carrying warnings, or with no rating
   (shown as "Not Rated"), a warnings screen comes first, whichever reading
   page they enter by: chapter 1, a shared link
   to a later chapter, or the entire work. "Continue" goes to the page they
   asked for, and the screen isn't shown again for that work until the browser
   session ends. Signed-in readers can turn the screen off; the choice is saved
   to their account. Signed-out readers can't turn it off.
   If the work's chapters were split uncertainly, the work and reader pages
   carry one line: "Chapters may be imperfect; a moderator will check."
6. They read. Next and previous chapter links sit at both ends of the chapter.
   "Entire work" shows every chapter on one page.

**2. Sign in** (any role)
1. They give an email address on the sign-in page. Turnstile runs alongside,
   so this step needs JavaScript; with it off, the page says so.
2. A "Check your email" page tells them the link lasts 15 minutes and may take
   a minute to arrive.
3. The link opens a short page with a "Sign in" button (a POST form, so a mail
   scanner opening the link in advance can't use it up). Pressing it signs them
   in, with or without JavaScript, and sends them back to the page they started
   from. It uses a stored same-site `next` value, never an open redirect.
4. An email with no account gets one at this point. A new account first lands
   on a one-time terms page (`/welcome/terms`) and must accept before going
   anywhere else; then it continues to `next`. Returning users never see it.

**3. Upload works** (uploader)
1. They pick one or more `.epub` files on the upload page and submit. Each
   file goes straight to R2 with a progress bar; uploading needs JavaScript.
2. Each file appears on *My uploads* with a status: processing, live, held for
   review, already in the archive, or rejected with a plain reason. A held
   version isn't public; only they and the moderators see it.
3. Once a file is live, they can open the work. "Already in the archive" links
   to the work that's already there.

**4. Remove a work or opt out** (author, or anyone acting for them)
1. They follow "Ask for this to be removed" on a work page, or "Remove my work"
   in the footer. No sign-in is needed.
2. They choose one work (prefilled from the work page) or a whole pseud, then
   give a contact email and a short statement. Turnstile runs alongside, so
   this needs JavaScript; with it off, the page says so and gives the
   moderators' contact address.
3. Every requester sees the same confirmation: "Your request was received; a
   moderator will review it and email you." Nothing on the page depends on
   whether the work was hidden, so it never reveals that a requester is
   blocked. (An unblocked request still hides the work at once; the work page
   shows that, not the confirmation.)
   A form missing a contact email, or a work or pseud, comes back with a 400
   and the errors marked. If they gave an AO3 URL for a work that isn't in
   the archive, nothing is stored, and the page says so and suggests opting
   out the pseud instead.
4. There's no proof of identity, because there's nothing to check against
   while AO3 is down. That's stated plainly on the form.

**5. Report a work** (signed-in user)
1. "Report" on a work page opens a short form: a reason and optional details.
   One reason is "This version is wrong", for a bad replacement.
   A signed-out reader is redirected to sign in first and brought back to the
   form (the same stored `next` value as sign-in). Authors who want a work removed
   use `/remove` instead, which needs no account.
2. A confirmation page explains what happens next.

**6. Moderate** (moderator)
1. Four queues: reports, takedowns, removal or opt-out requests, and *Works to
   check* (held versions, works live with the "may be imperfect" notice, and
   "This version is wrong" reports). Each is a plain table, oldest first.
2. Each item has a detail page with actions: hide, remove, restore, approve,
   reject, block requester, ban uploader. A request's page lists the other
   requests from the same email or IP, so a mass-hiding spree can be undone at
   once. A *Works to check* item has approve (clears the notice or publishes the
   held version), make version current, hide and remove.
3. A work's admin page lists every version (date, uploader, chapter count)
   with "Make current". Only moderators can roll back.
4. Anyone else gets a 404 for every `/admin` URL.

## Page inventory

Every page renders without JavaScript, and reading, browsing and search work
fully. The forms with a Turnstile check (sign-in, upload, `/remove`, and the
wait list before launch) need JavaScript and show a `<noscript>` message
without it. Elsewhere the
"JS adds" column is progressive enhancement only.

| Page | URL | Who | Without JS | JS adds |
| --- | --- | --- | --- | --- |
| Coming soon | `/` while `PRELAUNCH` is on | all | What rarepair is and what opens; `<noscript>` message: joining the wait list needs JavaScript | Email form with Turnstile, "check your email to confirm", error states |
| Confirm wait list | `/waitlist/confirm?token=…` | all | "Confirm" button (POST form), then "You're on the list"; used, expired or unknown links say so, with a link to `/`; after launch every link says the archive is open, with a link to `/` | — |
| Home / browse | `/` | all | Search box, popular fandoms, recently added | — |
| Search results | `/search?q=…` | all | GET form, paged results, filter form | — |
| Fandom / tag listing | `/tags/:slug` | all | Paged works, sort and filter as a GET form | — |
| Work page | `/works/:id` | all | Full metadata, chapter list, links; the "may be imperfect" notice when it applies | — |
| Warnings screen | `/works/:id/warnings` | all | Shown on first entry to any reading page of a warned or Not Rated work, then remembered for the session; Continue link to the page asked for, plus a turn-off checkbox when signed in (saved to the account) | — |
| Chapter reader | `/works/:id/chapters/:n` | all | Chapter, nav, settings link; the "may be imperfect" notice when it applies | Settings without reload, saves position |
| Entire work | `/works/:id/full` | all | All chapters on one page; the "may be imperfect" notice when it applies | Saves position |
| Reader settings | `/settings/reader` | all | POST form sets a cookie, then redirects back; signed-in readers also get the warnings on/off choice, saved to their account | Applied live from the reader |
| Sign in | `/login` | all | `<noscript>` message: signing in needs JavaScript | Email form with Turnstile, "check your email", error states |
| Confirm sign-in | `/login/confirm?token=…` | all | "Sign in" button (POST form); used, expired or unknown links redirect to `/login` with a message | — |
| Accept terms | `/welcome/terms` | new accounts, once | Terms summary, link to `/terms`, Accept button (POST form); every other signed-in page redirects here until accepted | — |
| Upload | `/upload` | signed in | `<noscript>` message: uploading needs JavaScript | Turnstile, then direct-to-R2 upload with progress, one or more files |
| My uploads | `/me/uploads` | signed in | Status list that refreshes itself with `<meta http-equiv="refresh">` while anything is processing | Updates in place |
| Remove my work / opt out | `/remove` (`?work=:id` prefills) | all | `<noscript>` message with the moderators' contact address | Request form with Turnstile, then a confirmation page that is the same for every requester |
| Report | `/works/:id/report` | signed in (others are redirected to sign in, carrying `next`) | Form, then a confirmation page | — |
| DMCA notice | `/dmca` | all | Statutory notice form | — |
| Moderation queues | `/admin/{reports,takedowns,requests,works}` | moderator (404 for anyone else) | Tables with detail pages; `/admin/works` is *Works to check* | — |
| Work admin | `/admin/works/:id` | moderator (404 for anyone else) | Every version (date, uploader, chapter count) with "Make current"; approve, hide, remove | — |
| About / terms / privacy | `/about`, `/terms`, `/privacy` | all | Static | — |
| Hidden work | `/works/:id`, every chapter URL and `/full` (451) | all | One line naming the cause: "Temporarily hidden after a removal request", "Temporarily hidden after reader reports" or "Temporarily hidden by a moderator", with no details. Left out of search, listings and the home page | — |
| Removed work | `/works/:id`, every chapter URL and `/full` (410) | all | "This work has been removed", with no details | — |
| Too many requests | any rate-limited or quota-limited action (429) | all | Plain page saying when to try again, matching `Retry-After` | — |
| Not found | any (404), including `/admin` for non-moderators and held versions | all | Search box and home link | — |

## Where the frontend changes the architecture

Discovery and review turned up three places where "works without JS" or the CSP collide
with the architecture as written. These are the resolutions. ARCHITECTURE.md is
updated to match.

1. **Forms with Turnstile need JS.** Turnstile can't produce a token without
   JavaScript, and sign-in, upload, `/remove` and the wait list before launch
   all require one. So those forms need JS and show a `<noscript>` message without it, while
   reading, browsing and search stay fully usable with JS off. Uploads are
   direct presigned PUTs to R2 with progress (R2 doesn't accept form POSTs);
   the earlier no-JS multipart path through the Worker was dropped. Turnstile
   pages add `frame-src https://challenges.cloudflare.com` to the CSP.
2. **Reader settings under the CSP.** `style-src 'self'` blocks inline `style=`
   attributes. So settings are attributes on `<html>`
   (`data-theme="dark" data-size="l" data-leading="relaxed"`), set on the
   server from the settings cookie. The values live in the stylesheet as CSS
   variables keyed off those attributes. With JS off, the settings form is a
   POST that sets the cookie and redirects back. With JS on, a script flips the
   attributes and writes the cookie. The script is served from `'self'` with
   the page's nonce.
3. **Upload status without JS.** *My uploads* refreshes itself with a
   `<meta http-equiv="refresh" content="5">` while any upload is processing,
   and drops it once nothing is. CSP doesn't block that, and it needs no
   script.

## Typographic system

**Faces.** System font stacks only, with no web fonts. That means no font
download, no flash of unstyled text, and no `font-src` exceptions in the CSP.
The one exception is the wait list's pages (*Decisions so far*): their fonts are
served from `rarepair.fans` itself, which `default-src 'self'` already allows,
with `font-display: swap` so its text shows in the system stacks until they
load.
- Interface: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- Reading: `Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif`
  by default, with sans-serif as a reader setting.

**Scale.** A ratio of about 1.25 from a 16 px base for the interface: 13 /
16 / 20 / 25 / 31 / 39. The reader's body text is 18 px by default, with
settings S/M/L/XL at 16/18/20/23.

**Hierarchy, from most to least prominent.** Work title, then author, then
rating and warnings (the same size as author, weight 600), then
fandom, then summary, then tags, then stats. The same order holds on cards and
on the work page. Only size and spacing change.

**Measure and rhythm.** The reader is capped at `66ch` and line height 1.6. The
interface uses 1.45. Spacing is on a 4 px grid, and sections are separated by
whitespace and single hairline rules, not boxes.

**Colour.** Near-black on off-white, with one accent for links and focus rings.
Themes are light, dark and sepia, set by `data-theme`, with
`prefers-color-scheme` as the default. Ratings and warnings get **no** colour
coding. Colour can't be the only signal, and coloured badges read as
decoration in a minimal design. They're bold text with labels spelled out.

## Components

- **Work card.** Lines in this order:
  1. title, then author or "Anonymous"
  2. **Rating · Warnings**, spelled out, e.g. "Mature · Graphic Depictions Of
     Violence". A work with no rating reads "Not Rated"
  3. fandoms
  4. a summary clamped to 3 lines with CSS `line-clamp`, followed by a
     "more" link to the work page. The full text stays in the HTML for screen
     readers and search engines
  5. tags: relationships first, then characters, then a count of other tags
  6. a stats line: words, chapters (x/y), complete or in progress, last
     updated

  Line 2 is never truncated. On a phone, the warnings wrap onto as many lines
  as they need.
- **Tag list.** A comma-separated inline list in small type. Every tag is a link.
  The type (relationship, character, freeform) is shown by its position and a
  visually hidden label, not by colour.
- **Chapter nav.** Previous, a chapter `<select>` (with a no-JS form button) and
  next, at both the top and bottom of the chapter.
- **Pagination.** Previous and next plus page numbers, all real links.
- **Status badge.** Text only: "Processing", "Live", "Held for review",
  "Already in the archive" (for `duplicate`, with a link to the work),
  "Rejected: not an AO3 export".
- **Review notice.** One plain line on the work page and every reader page of
  a work whose chapters the parser wasn't sure of: "Chapters may be imperfect;
  a moderator will check." It goes once a moderator approves the work.
- **Flash message.** A one-line notice at the top of the page after a POST,
  carried over the redirect in a short-lived cookie.
- **Temporary banner.** One line at the very top of every page, linking to
  `/about`.

## Reading experience

- The text column sits centred at `66ch`. The only chrome is a slim top bar
  with the work title and a settings link, which scrolls away.
- Chapter notes come before the text, end notes after, both in a smaller,
  muted style. The summary is not repeated on chapter pages.
- Settings: theme, size, line spacing, and serif or sans, kept in a cookie.
  Signed-in readers also choose whether to show the warnings screen; that
  choice is saved to their account, not the cookie.
- With JS on and the reader signed in, the reading position (chapter and scroll
  percentage) is saved every few seconds. On return, a "Continue where you left
  off" link appears on the work page. It doesn't jump the reader there without
  asking.
- `prefers-reduced-motion` turns off all smooth scrolling.

## Accessibility and devices

- WCAG 2.2 AA. Every page has a skip link, landmarks, and exactly one `<h1>`
  in its own chrome (the page or work title), with a heading order that matches
  the visual order. Headings inside a chapter come from the uploaded work and
  are not counted; the sanitizer keeps `h1`–`h6` as written. Demoting them a
  level under the chapter title is a possible later improvement.
- At 360 px wide, nothing scrolls sideways. The gate checks this.
- Every action can be reached by keyboard. Focus rings are always visible, in
  the accent colour.
- The warnings screen is a full page, not a modal, so it needs no focus
  trapping and works with JS off.
- Pages make sense in reader modes and with CSS turned off, since the HTML
  order is the reading order.

## Copy and tone

- Plain, calm and brief. This is a lifeboat, not a brand.
- Rejections say what happened and what to do next, for example "This file
  isn't an AO3 download, so we can't accept it here."
- Limits say when to try again, for example "Too many sign-in requests. Try
  again in a minute." A failed Turnstile check shows the form again with a
  one-line error.
- Never imply the archive is AO3 or approved by AO3. Credit always goes to the
  original work URL.

## What to validate first

These guesses are the most likely to be wrong, and the cheapest to test with a
handful of displaced readers:

1. **Is minimal browsing too thin?** Can readers scan a results page as fast as
   they're used to with tag-dense blurbs? Test the work card at real tag counts
   (20+ tags).
2. **Text badges versus familiar symbols.** Do readers find rating and warnings
   quickly without the icon grid they know?
3. **Is chapter-level position enough** for readers who can't use JS, or is that
   a non-issue?
4. **Discovery without wrangled tags.** Without canonical tags, is
   fandom-level browsing usable, or do near-duplicate fandom names (e.g. "Harry
   Potter - J. K. Rowling" against "Harry Potter") make it confusing straight
   away?
5. **Uploader motivation.** Will people upload in bulk? If so, the "later" bulk
   upload moves into the MVP.

## Open questions

None right now. Summary clamping, what the home page leads with, the AO3
link behaviour and the coming-soon typography are settled in *Decisions so
far*.
