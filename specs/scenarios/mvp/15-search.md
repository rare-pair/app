# Scenario: Metadata search

Relates to: docs/ARCHITECTURE.md § Decisions so far (Search scope), § Why these pieces (Neon Postgres), § EPUB processor (Scope for v1), § Surge controls (Status codes), § Author requests & takedowns (What hidden, held and removed works show), § MVP vs later (6. Search); docs/FRONTEND-DISCOVERY.md § Page inventory (Search results, Too many requests), § Decisions so far (Pagination)

## Setup
- Live works indexed in Postgres with a `search` tsvector over title, author, tags and summary, plus `pg_trgm` for fuzzy matching
- Work W1 titled "The Lighthouse Keeper" by pseud "saltwater", tagged "Found Family", whose summary mentions "storm"
- Work W2 whose chapter text, but no metadata, contains the word "zeppelin"
- Enough matching works to fill more than one results page
- The rate-limiting binding is configured for search per IP and per user
- Work W3 titled "Lighthouse Nights", hidden after reader reports

## Cases

### Search by title
- GIVEN work W1
- WHEN a reader searches `/search?q=lighthouse keeper`
- THEN W1 is in the results

### Search by author
- GIVEN work W1
- WHEN a reader searches for "saltwater"
- THEN W1 is in the results

### Search by tag
- GIVEN work W1
- WHEN a reader searches for "found family"
- THEN W1 is in the results

### Search by summary
- GIVEN work W1
- WHEN a reader searches for "storm"
- THEN W1 is in the results

### Fuzzy matching tolerates typos
- GIVEN work W1
- WHEN a reader searches for "lighthose keeper"
- THEN W1 is in the results through trigram matching

### Chapter text is not searched
- GIVEN work W2 whose only mention of "zeppelin" is in chapter text
- WHEN a reader searches for "zeppelin"
- THEN W2 is not in the results

### Search is a GET form
- GIVEN the search box on any page
- WHEN a reader submits it with JavaScript off
- THEN the browser loads `/search?q=…` and the results render server-side

### Results are paged with real URLs
- GIVEN a query matching more works than fit on one page
- WHEN the results render
- THEN pagination links are real URLs for each page

### Results can be sorted and filtered
- GIVEN a results page
- WHEN the reader sorts by best match, updated date or word count, filters by rating or completion, or narrows by a tag of a chosen type, in the search form
- THEN they are applied through a GET request and appear in the URL
- AND best match is the default sort
- AND an older link that narrows by `fandom=` still narrows by that fandom tag

### Result cards show rating and warnings
- GIVEN any search result
- WHEN it renders
- THEN its card shows rating and archive warnings in full

### Search is rate-limited
- GIVEN one IP or user that has reached the search rate limit in the current window
- WHEN they search again
- THEN the response is 429 with a `Retry-After` header
- AND a plain page says when to try again
- AND a blank search, which lists every work, is never limited and spends none of the budget

### Hidden works are left out of results
- GIVEN hidden work W3 and live work W1
- WHEN a reader searches for "lighthouse"
- THEN W1 is in the results and W3 is not

### Search needs no account
- GIVEN a signed-out visitor
- WHEN they search
- THEN results are shown without sign-in

### A blank search lists every live work
- GIVEN more live works than fit on one page, across several fandoms
- WHEN a reader opens `/search` with no query, or follows "All works" from `/`
- THEN every live work is listed as work cards, a page at a time, with pagination links that are real links
- AND with no sort chosen, or best match, they are ordered by updated date, since there is nothing to match
- AND sorting and filtering work as on a results page

### A blank search leaves out every work that isn't live
- GIVEN a hidden work, a removed work, a held work and a work still processing
- WHEN a reader pages through a blank search
- THEN none of them is listed, and none is counted toward the pages

### A blank search shows adult works as every listing does
- GIVEN a live work rated Explicit, a live Not Rated work and a live work a moderator marked adult
- WHEN their cards render in a blank search
- THEN each is listed, its rating and warnings spelled out and its adult mark shown
- AND its link goes to the work page, so the warnings screen still comes before its reading pages

### A blank search past the last page
- GIVEN a blank search with two pages of works
- WHEN a reader opens its third page
- THEN the response is 404
- AND with no live works at all, the first page is a 200 that says there are no works yet

### A blank search is briefly cached
- GIVEN a blank search
- WHEN it is served
- THEN it has the tag listing's short private cache lifetime with stale-while-revalidate
- AND a search with a query is never cached
