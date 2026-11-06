# Scenario: Updates on the home page, and a static page for each post

Relates to: docs/FRONTEND-DISCOVERY.md § Decisions so far (Home page, Updates), § Page inventory (Home / browse, Update post); docs/ARCHITECTURE.md § MVP vs later; docs/release-notes/v0.1.0.md; specs/scenarios/mvp/14-browse-and-home.md; specs/scenarios/mvp/20-site-chrome-and-legal.md; specs/scenarios/mvp/21-accessibility-and-no-js.md; specs/scenarios/mvp/22-waitlist.md; specs/scenarios/mvp/24-crawler-and-agent-blocking.md; specs/scenarios/later/08-updates-list-and-data.md

Updates are short posts from the operator: release notes first, and news later. There is no list page and no paging yet. Those come with specs/scenarios/later/08-updates-list-and-data.md, so an update that drops off the home page can still be opened by its address but has no link until then.

## Setup
- Updates are one list in the web Worker's code, with no database table, migration or admin page. Adding one is a code change and a deploy
- Each update has a slug, a title, a summary, an author, a created date and a body. The title, summary and author are plain text, and the created date is a calendar date with no time
- A post's address is `/updates/:slug`
- Dates show as `YYYY-MM-DD`, as work cards and work pages show them
- Updates A, B, C and D, created in that order on four different days, unless a case says otherwise
- The first real update:
  - Slug: `release-0-1-0-chuhura`
  - Title: `rarepair v0.1.0 "Chuhura"`
  - Summary: `rarepair is open. It is a temporary, community-run reading archive for fanworks while the original archive is offline.`
  - Author: `admin and 🤖`
  - Created date: the day the archive opens, which the operator confirms on the PR
  - Body: docs/release-notes/v0.1.0.md, everything below its title line

## Cases

### The home page shows the latest updates, newest first
- GIVEN updates A, B, C and D
- WHEN a visitor opens `/`
- THEN an "Updates" section shows D, C and B, in that order
- AND A is not on the page

### Fewer than three updates
- GIVEN only the update `release-0-1-0-chuhura`
- WHEN a visitor opens `/`
- THEN the "Updates" section shows that one card, with no empty space held for others

### No updates
- GIVEN no updates
- WHEN a visitor opens `/`
- THEN there is no "Updates" heading and no empty list

### Two updates on one day
- GIVEN two updates with the same created date
- WHEN they are listed
- THEN the one added to the list later comes first, on every load

### Where the section sits
- GIVEN any visitor
- WHEN they open `/`
- THEN the search box still comes first
- AND "Updates" comes straight after it, above popular fandoms and recently added works

### Updates show when the archive is empty
- GIVEN at least one update and no live works
- WHEN a visitor opens `/`
- THEN the "Updates" section shows above the "no works here yet" line

### What a summary card shows
- GIVEN an update
- WHEN its card renders on the home page
- THEN it shows the title, the summary in full, the author and the created date
- AND the title is a link to `/updates/:slug`
- AND the date is in a `<time>` element with the same date in `datetime`

### Text is escaped
- GIVEN an update whose title holds quotes and an ampersand, as `rarepair v0.1.0 "Chuhura"` holds quotes
- WHEN its card and its post render
- THEN the text shows exactly as written, on the page, in the document's title and in its link card

### What a post shows
- GIVEN a visitor on `/updates/:slug`
- WHEN the page renders
- THEN the title is the page's main heading
- AND the summary, the author and the created date come next, then the body
- AND the page has the shared layout, banner and footer, like `/about`

### The post is static
- GIVEN any post
- WHEN it is requested
- THEN the response makes no database, KV or R2 read for the post, and signed-in visitors get the same post as signed-out ones, inside the same header
- AND its caching headers are those of `/about`

### A post works without JavaScript
- GIVEN a browser with JavaScript off, or with CSS off
- WHEN a visitor follows a card from the home page and reads the post
- THEN both pages are complete and make sense

### A post meets the page rules
- GIVEN the post `release-0-1-0-chuhura` and the home page's "Updates" section
- WHEN spec 21's checks and the 360 px check run
- THEN both pass, and nothing scrolls sideways
- AND a post's body passes the strict CSP: no inline styles, no scripts

### Posts are in the page inventory
- GIVEN the browser suite's page inventory and its crawl
- WHEN they run
- THEN `release-0-1-0-chuhura` is in the inventory, and the crawl reaches it by the home page's card

### The first update's text is the operator's own
- GIVEN the post `release-0-1-0-chuhura`
- WHEN its text is compared with docs/release-notes/v0.1.0.md
- THEN every word, emoji and link matches, including the spelling and punctuation in "The long of it", "Some promises" and the rest of the operator's copy
- AND nobody corrects that copy in proofing, review or a follow-up, because the typos are part of the operator's voice
- AND the page has no "Draft: this text has not been proofread yet" line

### Branding holds in the first update
- GIVEN the post `release-0-1-0-chuhura`
- WHEN it renders
- THEN it uses no AO3 or OTW name, and the branding test covers it

### An unknown slug is not found
- GIVEN no update with the slug `nope`
- WHEN a visitor opens `/updates/nope`
- THEN the answer is the 404 not-found page

### No list page yet
- GIVEN this spec's build
- WHEN a visitor opens `/updates`
- THEN the answer is the 404 not-found page, and the home page has no "All updates" link

### Closed before launch
- GIVEN `PRELAUNCH` is on
- WHEN a visitor opens `/updates/release-0-1-0-chuhura`
- THEN they get the 302 to `/`, as for every other closed page, because this post says the archive is open
- AND the coming-soon page shows no "Updates" section

### Terms gate applies as on the home page
- GIVEN a signed-in account that has not accepted the terms
- WHEN it opens a post
- THEN it is sent to accept them, as on `/`

### Bots are refused posts too
- GIVEN a declared automated client
- WHEN it requests a post
- THEN it gets spec 24's 403, as on every other page

### A post has a link card
- GIVEN any post
- WHEN its HTML is served to a browser
- THEN it holds a text-only article card with the post's title and summary and its own address
- AND no link card shows the body

## Before launch
The first update's "Bots and crawlers" section describes specs/scenarios/mvp/24-crawler-and-agent-blocking.md, and it says what those protections do as fact. As spec 24 says of the About section, this text must not go live before them. A post is closed until launch, so this holds if launch waits for them. If any of them won't make launch, the operator changes docs/release-notes/v0.1.0.md and the post with it.
