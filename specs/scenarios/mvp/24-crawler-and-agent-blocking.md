# Scenario: Blocking crawlers and agents from fic text

Relates to: docs/ARCHITECTURE.md § Decisions so far (Who can read uploads, Crawlers and agents), § Why these pieces (Hosts), § Reading, § Crawlers and agents, § Surge controls; docs/FRONTEND-DISCOVERY.md § Page inventory (Automated access refused, Too many requests); specs/scenarios/mvp/09-content-origin.md; specs/scenarios/mvp/11-reader-and-csp.md; specs/scenarios/mvp/19-surge-controls-and-quotas.md; specs/scenarios/mvp/21-accessibility-and-no-js.md

What this does and does not stop: refusals stop a crawler or agent that identifies itself. The read throttles only slow one that poses as a browser. An agent driving a person's real browser looks like that person and is not stopped. Reading stays public, so a patient scraper spread across many addresses can still get through.

## Setup
- Fic text is `/works/:id/chapters`, `/works/:id/chapters/:n` and `/works/:id/full` on `rarepair.fans`, and `/works/:id/img/*` and `/originals/*` on `content.rarepair.fans`. These are the protected paths
- Work pages, tag listings, search and the home page are not protected
- A live work W with chapters, images and an original, a hidden work H and a removed work R
- `PRELAUNCH` is off, unless a case says otherwise. With it on, the protected paths on `rarepair.fans` redirect as in specs/scenarios/mvp/22-waitlist.md, and a request to `www.rarepair.fans` always gets its 308 first, as in specs/scenarios/mvp/11-reader-and-csp.md
- The crawler list is one list that both Workers are built from: product names of AI crawlers, AI agents, scraping tools and HTTP libraries that identify themselves. It matches as plain case-insensitive text, with no regular expressions. It holds no word as broad as `bot`, no pattern for headless browsers or browser automation in general, and none for assistive technology
- A declared automated client is a request with a `Signature-Agent` header, or with a `User-Agent` matching the crawler list. The signature is not verified: announcing itself is enough. A missing `User-Agent` is not a declaration
- Zone config: one custom rule blocks `cf.client.bot` on each host's protected paths. A request it blocks gets Cloudflare's own block page and never reaches a Worker. Bot Fight Mode, Super Bot Fight Mode and Browser Integrity Check are off, since each can challenge a reader or set a cookie. AI Crawler and Agent access policies stay on allow and Bot Preference Sync stays off, since both act on the whole zone
- Read throttles are Workers rate-limiting bindings keyed per client as in specs/scenarios/mvp/19-surge-controls-and-quotas.md (an IPv4 address, or an IPv6 /64). First values per 60 seconds, to be revisited in load testing: 120 chapter pages, 10 `/works/:id/full` and 10 originals. At those limits one address can still take 14,400 whole works a day, so the throttles slow a scraper and don't stop one
- One read is one GET or HEAD of a chapter page, `/works/:id/full` or an original. The chapter select's redirect, the warnings screen and a refused request don't count

## Cases

### Declared automated clients are refused chapter text
- GIVEN a request for a chapter of W, or `/works/:id/full`, from each kind of declared automated client
- WHEN the web Worker receives it, by GET or HEAD
- THEN the response is 403 with the plain automated-access page and no chapter text, title or other detail of the work
- AND it has `Cache-Control: no-store`, the strict CSP and `Strict-Transport-Security`

### Redirects still come first
- GIVEN a declared automated client asking for a chapter of W
- WHEN it asks on `www.rarepair.fans`, or on `rarepair.fans` with `PRELAUNCH` on
- THEN the response is the same redirect a browser gets, with no chapter text

### A word inside a browser's user agent is not a match
- GIVEN a real browser whose `User-Agent` holds the letters `bot` inside a phone's model name
- WHEN it asks for a chapter of W
- THEN the chapter is served

### The crawler list ignores case
- GIVEN a `User-Agent` holding a listed product name in other letter case
- WHEN it asks for a chapter of W
- THEN the response is the 403

### A session does not exempt a declared automated client
- GIVEN a request with a valid session cookie and a `User-Agent` matching the crawler list
- WHEN it asks for a chapter of W
- THEN the response is the same 403

### The refusal comes before the edge cache
- GIVEN a chapter page of W stored in the signed-out edge cache
- WHEN a declared automated client requests it
- THEN the response is the 403, not the cached page
- AND the cached page is unchanged, and a later signed-out reader still gets it

### A refused request costs no lookups
- GIVEN a declared automated client carrying a session cookie
- WHEN it requests a chapter of W
- THEN the response is the 403 with no session lookup, no database query and no R2 read

### The refusal does not reveal a work's status
- GIVEN hidden work H, removed work R and an id with no work
- WHEN a declared automated client requests a chapter or `/full` of each
- THEN each response is the same 403 as for live work W, never 451, 410 or 404

### Declared automated clients are refused originals and images
- GIVEN a request for W's original or one of its images on `content.rarepair.fans`, whether or not it is in the data centre's cache
- WHEN it comes from a declared automated client
- THEN the response is 403 with no body and no bytes of the file
- AND it has `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` and no `Set-Cookie`
- AND it is not stored in the cache, and the file's cached entry is unchanged

### Content origin refusals log no URL
- GIVEN a refused request on `content.rarepair.fans`
- WHEN the refusal is recorded
- THEN nothing logged holds the URL, the work id or the client's address

### Refusals store nothing about the client
- GIVEN a refused request on either host
- WHEN it has been answered
- THEN no address, user agent or signature was written to Postgres, KV or R2

### Metadata pages stay open to crawlers
- GIVEN a request with a `User-Agent` matching the crawler list, or a `Signature-Agent` header
- WHEN it asks for W's work page, a tag listing, a search or the home page
- THEN it gets the same page a browser gets, with no `X-Robots-Tag: noindex`

### Work pages keep their link previews
- GIVEN a link preview service that identifies itself
- WHEN it fetches W's work page, and then one of W's chapters
- THEN the work page is served and the chapter is refused, so a shared chapter link shows no preview

### Readers are never challenged on protected paths
- GIVEN a reader with an ordinary browser, JavaScript on or off
- WHEN they open a chapter of W, `/works/:id/full`, one of its images and its original
- THEN each is served with no challenge page, no Turnstile and no extra script
- AND the page's CSP is unchanged, with no third-party frame

### Assistive and in-browser tools keep working
- GIVEN a chapter page of W open in a browser
- WHEN the reader uses a screen reader, the browser's translation, a reader extension, Ctrl+F or print
- THEN each works on the chapter text as normal

### Server-side tools that identify themselves are refused
- GIVEN a translation proxy or read-later service that fetches pages on its own servers and identifies itself
- WHEN it fetches a chapter of W for a reader
- THEN it is refused like any other declared automated client, an accepted cost of this design
- AND no such tool is exempted by name

### Browser automation that does not identify itself is served
- GIVEN the real-browser journeys in `apps/web/browser/`, running headless with the browser's own user agent
- WHEN they open a chapter of W
- THEN the chapter is served
- AND no request gets the 403 for looking headless, for its IP range or for its request rate; a high rate only meets the read throttles

### robots.txt keeps crawlers out of chapter pages
- GIVEN any client, a declared automated client included
- WHEN it requests `/robots.txt` on `rarepair.fans`, with `PRELAUNCH` on or off
- THEN the response is 200 `text/plain`, disallows `/works/*/chapters`, `/works/*/full` and `/search` for every user agent, and allows everything else
- AND it states `Content-Signal: search=yes, ai-input=no, ai-train=no`
- AND it has `Cache-Control: public, max-age=3600`, never `immutable`

### Search stays reachable by crawlers that ignore robots.txt
- GIVEN `/search` is disallowed only so that crawlers don't run endless queries
- WHEN a crawler requests it anyway
- THEN it gets the search page, under the search limit in specs/scenarios/mvp/19-surge-controls-and-quotas.md

### robots.txt keeps crawlers off the content origin
- GIVEN any client, a declared automated client included
- WHEN it requests `/robots.txt` on `content.rarepair.fans`
- THEN the response is 200 `text/plain` disallowing `/` for every user agent, with `nosniff`, `Cache-Control: public, max-age=3600` and no `Set-Cookie`
- AND it is the only path that origin serves besides images and originals

### Protected responses ask not to be indexed or used
- GIVEN a chapter page of W, `/works/:id/full`, one of W's images and its original
- WHEN each is served to a reader, from a cache or not
- THEN it has `X-Robots-Tag: noindex, noarchive, noai, noimageai`

### Chapter reads are throttled per IP
- GIVEN one IP that has passed the chapter read limit within a window, with a browser's user agent
- WHEN it requests another chapter of any work
- THEN the response is 429 with a `Retry-After` header and the plain too-many-requests page, even if that chapter is in the edge cache

### Entire-work reads have a lower limit
- GIVEN the configured limits for chapter reads and for `/works/:id/full`
- WHEN they are compared
- THEN the `/full` limit is the lower, because one request returns a whole work

### Original downloads are throttled per IP
- GIVEN one IP that has passed the original download limit within a window, with a browser's user agent
- WHEN it requests another original, by a full or a `Range` request, cached or not
- THEN the response is 429 with a `Retry-After` header, no body, `nosniff`, `Cache-Control: no-store` and no `Set-Cookie`, and it is not stored in the cache

### Images are not throttled
- GIVEN a chapter with many images, read by a reader on a shared IP
- WHEN their browser loads the images
- THEN all of them are served

### A failing limiter does not stop reading
- GIVEN the rate-limiting binding throws on a read
- WHEN a reader requests a chapter, `/works/:id/full` or an original
- THEN it is served as if under the limit, and the failure is logged with no URL or address

### Throttled readers recover after the window
- GIVEN an IP throttled on chapter reads or original downloads
- WHEN the rate-limit window has passed
- THEN its next request succeeds

### Terms forbid automated collection
- GIVEN a visitor on `/terms`
- WHEN they read it
- THEN it says that automated collection of fic text and its use to train AI models are not allowed
- AND it says this applies to everyone who uses the site, not only people with an account

### About page summarizes these efforts
- GIVEN a visitor on `/about`
- WHEN they read it
- THEN a "Crawlers and AI agents" section says the app is built by a swarm of AI coding agents, and that we are here to serve, not to steal
- AND it summarizes what is refused and throttled, and says plainly that this can't stop everything
- AND it never goes live before the refusals and throttles it describes, so it is added with them or after them
- AND its text starts from this draft, for the operator to proof with the rest of the page:
  - rarepair is built by a swarm of AI coding agents, directed by a person. We know how that sounds next to fanworks, so to be plain: we are here to serve, not to steal.
  - Anything that identifies itself as a crawler or an AI agent is refused chapters, images and original files, and that includes search engines. They can still see work pages, so people can find a work. We ask crawlers not to index the text or use it for AI, and we limit how fast one network address can read or download. Readers are never asked to prove they are human to read.
  - We can't promise this stops everything. The archive stays open to read, so a scraper pretending to be a browser, or an agent using someone's own browser, can still get what any reader can.

### Refusal page explains itself
- GIVEN a person whose browser sends a user agent on the crawler list
- WHEN they get the 403 page
- THEN it says plainly that automated access to chapters isn't allowed, and links to the home page and `/about`

### Refusals are counted by reason
- GIVEN requests refused or throttled by either Worker
- WHEN an operator opens the operations dashboard
- THEN they can see how many were refused by each reason (signature, crawler list) and how many reads were throttled
- AND each is counted from a log line holding only that reason, with no URL or address
- AND requests the zone rule blocked are read from Security Events instead, since they never reach a Worker

### Zone rule is in place before launch
- GIVEN the deployed zone
- WHEN an operator checks the zone's settings, Security Events and AI Crawl Control
- THEN the custom rule is on and scoped to each host's protected paths, and Bot Fight Mode, Super Bot Fight Mode, Browser Integrity Check and Bot Preference Sync are off
- AND a response from `content.rarepair.fans` carries no zone-set cookie
- AND crawlers AI Crawl Control reports that the crawler list misses are added to the list
