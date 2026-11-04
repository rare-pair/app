# Scenario: Content origin (epub images and original downloads)

Relates to: docs/ARCHITECTURE.md § System overview, § Why these pieces (Two layers of XSS defense), § Reading (Download original epub), § Surge controls (Edge cache), § Author requests & takedowns (Removal really removes)

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
- THEN it has `Cache-Control: public, max-age=31536000, immutable`

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
