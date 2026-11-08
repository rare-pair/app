# Scenario: Home page, browsing and work cards

Relates to: docs/ARCHITECTURE.md § Dedupe (Tags), § MVP vs later (5. Browse), § Surge controls (Edge cache), § Author requests & takedowns (What hidden, held and removed works show); docs/FRONTEND-DISCOVERY.md § Decisions so far (Warnings, Pagination, Card summaries, Home page), § Page inventory (Home / browse, Fandom / tag listing, Search results), § Components (Work card, Tag list, Pagination)

## Setup
- More than one page of live works in fandom F, with mixed ratings, completion states, updated dates and word counts
- A work with 20+ tags and a summary longer than 3 lines
- An anonymous work
- Two fandom tags written "Harry Potter" and "harry  potter!" that share a `name_norm`
- A work H in fandom F, recently added, that is now hidden after a removal request

## Cases

### Home page leads with search
- GIVEN any visitor
- WHEN they open `/`
- THEN a search box comes first
- AND updates (specs/scenarios/mvp/25-updates.md), popular fandoms and recently added works are below it, in that order

### Tag listing shows paged works
- GIVEN fandom F with more works than fit on one page
- WHEN a reader opens `/tags/:slug` for F
- THEN the first page of works is shown with pagination links

### Pagination uses real links
- GIVEN a paged listing
- WHEN it renders
- THEN previous, next and page numbers are real links with their own URLs
- AND there is no infinite scroll

### Sort by updated date
- GIVEN fandom F's listing
- WHEN the reader sorts by updated date using the GET form
- THEN works are ordered by updated date and the sort is in the URL

### Sort by word count
- GIVEN fandom F's listing
- WHEN the reader sorts by word count using the GET form
- THEN works are ordered by word count

### Filter by rating
- GIVEN fandom F's listing
- WHEN the reader filters to Explicit using the GET form
- THEN only Explicit works are listed

### Filter by tag and completion
- GIVEN fandom F's listing
- WHEN the reader narrows by a tag and by complete using the GET form
- THEN only complete works with that tag are listed

### Sort and filter work without JS
- GIVEN a reader with JavaScript off
- WHEN they change sort and filters on a listing and submit
- THEN the listing reloads with the new sort and filters applied

### Tag matching uses the normalized form
- GIVEN works tagged "Harry Potter" and works tagged "harry  potter!"
- WHEN tags are matched
- THEN both match through their shared `name_norm`
- AND each tag is still displayed exactly as written

### Work card line order
- GIVEN any work card in a listing
- WHEN it renders
- THEN its lines are, in order: title and author, rating and warnings, fandoms, summary, tags, stats

### Rating and warnings spelled out on cards
- GIVEN a work rated Mature with the warning "Graphic Depictions Of Violence"
- WHEN its card renders
- THEN line 2 reads "Mature · Graphic Depictions Of Violence" in bold text, with no colour coding or symbol icon

### Warnings line is never truncated
- GIVEN a work card with several long warnings at 360 px wide
- WHEN it renders
- THEN the warnings wrap onto as many lines as needed and none are clamped or hidden

### Summary is clamped with a more link
- GIVEN a work whose summary runs longer than 3 lines
- WHEN its card renders
- THEN the summary is clamped to 3 lines with CSS `line-clamp`, followed by a "more" link to the work page
- AND the full summary text stays in the HTML

### Card tags order
- GIVEN a work with relationships, characters and freeform tags
- WHEN its card renders
- THEN relationships come first, then characters, then a count of the other tags

### Card stats line
- GIVEN a work with 3 of 5 chapters posted, in progress
- WHEN its card renders
- THEN the stats line shows words, chapters as 3/5, in progress and last updated

### Anonymous work card
- GIVEN an anonymous work
- WHEN its card renders
- THEN the author line shows "Anonymous"

### Hidden works are left out of listings and the home page
- GIVEN hidden work H in fandom F
- WHEN a reader opens `/` and the listing for F
- THEN H appears in neither the recently added works nor the listing

### Listings are briefly cached
- GIVEN a work or tag listing
- WHEN it is served
- THEN it has a short cache lifetime with stale-while-revalidate

## All works

Every live work is listed by a blank search (specs/scenarios/mvp/15-search.md, *A blank search lists every live work*).

### The home page links to all works
- GIVEN live works
- WHEN a reader opens `/`
- THEN below the recently added works is an "All works" link to `/search`
- AND with no live works there is no such link
