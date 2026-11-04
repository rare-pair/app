# Scenario: Content origin (epub images and original downloads)

Relates to: docs/ARCHITECTURE.md § System overview, § Why these pieces (Two layers of XSS defense), § Reading (Download original epub), § Surge controls (Edge cache), § Author requests & takedowns (What hidden, held and removed works show; Removal really removes), § Connections

## Setup
- The content Worker serves `content.rarepair.fans`, a separate origin from `rarepair.fans`
- A live work W with images stored under `works/<ao3_work_id>/img/` and its original epub in `originals/`
- A signed-in user with a `rarepair.fans` session cookie

## Cases

### Images are served from the content origin
- GIVEN a chapter of work W that contains an image
- WHEN a reader loads the chapter
- THEN the image URL is on `content.rarepair.fans`, not `rarepair.fans`

### Content origin sets no cookies
- GIVEN any request to `content.rarepair.fans` for an image or original download
- WHEN the response is returned
- THEN it has no `Set-Cookie` header

### App session cookie is not sent to the content origin
- GIVEN a signed-in user whose session cookie is scoped to `rarepair.fans`
- WHEN their browser requests an image from `content.rarepair.fans`
- THEN the request carries no session cookie

### Responses forbid content sniffing
- GIVEN any image or original download served by `content.rarepair.fans`
- WHEN the response is returned
- THEN it has `X-Content-Type-Options: nosniff`

### Images and downloads are cached as immutable
- GIVEN any image or original download served by `content.rarepair.fans`
- WHEN the response is returned
- THEN it has `Cache-Control: public, max-age=31536000, immutable, s-maxage=43200`: the browser's year, and 12 hours in the data centre's cache

### Original epub downloads as an attachment
- GIVEN work W's page
- WHEN a reader follows "Download original epub"
- THEN the file is served from `originals/` on `content.rarepair.fans`
- AND the response has `Content-Disposition: attachment`

### Original epub is never displayed inline
- GIVEN a request for work W's original epub
- WHEN the response is returned
- THEN it never uses `Content-Disposition: inline` and is not rendered by the browser

### Content origin only serves images and original downloads
- GIVEN the content Worker
- WHEN a request asks it for a chapter fragment or an app page
- THEN it does not serve chapter HTML; chapters are only rendered on `rarepair.fans`
- AND the one other path it serves is the `robots.txt` in specs/scenarios/mvp/24-crawler-and-agent-blocking.md

### Removed work's images and downloads stop being served
- GIVEN work W whose images and original download have been fetched and edge-cached
- WHEN W is set to `removed`
- THEN `works/<ao3_work_id>/` and the raw upload are deleted from R2
- AND the images and download URLs are purged from the cache
- AND later requests for them no longer return the work's bytes

### A hidden work's image is refused, whatever the request
- GIVEN work W is hidden, for any cause, and its image is in R2 and not in the edge cache
- WHEN the image is requested by GET, HEAD, with a `Range` header, or with any conditional header
- THEN the response is 451 with no body, `Cache-Control: no-store` and `nosniff`
- AND it has no `Set-Cookie`, and nothing is stored in the edge cache

### A hidden work's original is refused, whatever the request
- GIVEN work W is hidden, for any cause, and its original is in R2 and not in the edge cache
- WHEN the original is requested by GET, HEAD, with a `Range` header, or with any conditional header
- THEN the response is 451 with no body, `Cache-Control: no-store` and `nosniff`
- AND it has no `Set-Cookie`, and nothing is stored in the edge cache

### A copy cached before a hide is served until it ages out
- GIVEN work W is live and its image is in the data centre's cache
- WHEN W is hidden and the image is requested again
- THEN the cached copy is still served, as a hide does not purge
- AND once the entry is gone, the next request is refused with 451

### A refusal names no cause
- GIVEN work W is hidden by a removal request
- WHEN its image is requested
- THEN no header of the 451 carries the hide cause

### A restored work's image and original are served again
- GIVEN work W was hidden and its files were refused
- WHEN W is restored
- THEN the next request for each returns the file with the headers of any other

### A removed work's files are a 404, as are unknown works and uploads
- GIVEN a removed work, a work no row names, a work id above 2147483647 and an upload no row names, each with a file in R2
- WHEN a file is requested
- THEN the response is a 404 with no body and `Cache-Control: no-store`

### An original whose upload has no work is a 404
- GIVEN an upload that ingest refused, whose original remains in R2
- WHEN the original is requested
- THEN the response is a 404

### A held version's original is a 404, though its work is live
- GIVEN a live work with a version held for review, and the held upload's original in R2
- WHEN that original is requested
- THEN the response is a 404
- AND the original of the work's current version is served

### A duplicate upload's original follows its work's status
- GIVEN a duplicate upload of work W, with an original in R2
- WHEN the original is requested while W is live, and again once W is hidden
- THEN it is served, and then refused with 451

### An image id with a leading zero is not a work
- GIVEN a live work 42900
- WHEN `/works/042900/img/<hash>` is requested
- THEN the response is a 404, with no status read

### An original's key without .epub is checked the same way
- GIVEN a hidden work's original stored under its upload id without `.epub`
- WHEN it is requested
- THEN the response is 451
