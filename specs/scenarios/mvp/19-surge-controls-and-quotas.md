# Scenario: Surge controls, rate limits and upload quotas

Relates to: docs/ARCHITECTURE.md § Decisions so far (Load target), § Surge controls (Status codes), § Ingestion pipeline, § Auth (magic link); docs/FRONTEND-DISCOVERY.md § Page inventory (Too many requests), § Copy and tone

## Setup
- Turnstile is configured on signup, login, upload and `/remove` requests
- The Workers rate-limiting binding covers login, upload requests and search, keyed per IP and per user, over 10- or 60-second windows
- Upload quotas are counted in Postgres (`user.upload_quota_used`)
- Users: a user E with quota left (on either tier), a brand-new user N, a trusted user T
- There are two daily quota tiers, a lower one for new accounts and a higher one for trusted users; the numbers and the rule for "trusted" are configuration, set before launch from load testing, and the cases below use whatever values are configured

## Cases

### Turnstile guards login and signup
- GIVEN a visitor
- WHEN they request a magic link without a passing Turnstile token
- THEN the response is 400 and shows the sign-in form again with an error

### Turnstile guards upload requests
- GIVEN signed-in user E
- WHEN E requests an upload without a passing Turnstile token
- THEN the response is 400 and the upload page shows the error

### Login is throttled per IP
- GIVEN one IP that has sent more login requests than the limit within a window
- WHEN it sends another
- THEN the response is 429 with a `Retry-After` header and a plain page saying when to try again

### Upload requests are throttled per user
- GIVEN user E who has sent more upload requests than the rate limit within a window
- WHEN E sends another
- THEN the response is 429 with a `Retry-After` header, even with quota left

### Search is throttled per IP
- GIVEN one IP that has sent more searches than the limit within a window
- WHEN it searches again
- THEN the response is 429 with a `Retry-After` header and a plain page saying when to try again

### Throttling recovers after the window
- GIVEN an IP throttled on search
- WHEN the rate-limit window has passed
- THEN its next search succeeds

### Daily quota allows uploads up to the limit
- GIVEN user E with one upload left in today's quota
- WHEN E confirms an upload (`POST /uploads/:id/complete`)
- THEN the confirm succeeds and the quota is used up
- AND the quota counts confirmed uploads, by UTC day, and resets at midnight UTC

### Daily quota refuses uploads past the limit
- GIVEN user E who has used all of today's quota
- WHEN E requests another upload, or confirms one
- THEN the response is 429 with a `Retry-After` header and a plain message saying when E can upload again (the next midnight UTC)
- AND an upload refused at confirm because the quota was already spent stays pending, so E can confirm it after the reset

### Quota is a hard limit under concurrency
- GIVEN user E with one upload left in today's quota, and two uploaded files
- WHEN E confirms both at the same time from different locations
- THEN exactly one succeeds, because the quota is counted in Postgres rather than the approximate rate limiter
- AND the other is refused with 429 and is never queued

### Brand-new accounts get the lower quota
- GIVEN brand-new user N
- WHEN N's daily quota is checked
- THEN it is the configured new-account limit

### Trusted users get the higher quota
- GIVEN trusted user T, who meets the configured rule for "trusted"
- WHEN T's daily quota is checked
- THEN it is the configured trusted-user limit, which is higher than the new-account limit

### Oversized objects are cleaned up at confirm
- GIVEN an object PUT through a presigned URL that exceeds 25 MB
- WHEN `/complete` is called
- THEN the object is deleted

### Abandoned uploads expire
- GIVEN an object under `uploads/` whose client never called `/complete`
- WHEN 7 days have passed
- THEN the R2 lifecycle rule has deleted it

### Upload flood becomes a backlog, not an outage
- GIVEN thousands of uploads confirmed in a short burst
- WHEN the ingest queue fills
- THEN browsing, search and reading keep responding while the queue drains at bounded consumer concurrency

### Content origin is edge-cached
- GIVEN an image or original download on `content.rarepair.fans`
- WHEN it is served
- THEN it has `Cache-Control: public, max-age=31536000, immutable`

### Listings use a short cache
- GIVEN a work or tag listing
- WHEN it is served
- THEN it has a short cache with stale-while-revalidate

### Operations dashboard
- GIVEN the deployed Workers
- WHEN an operator opens the dashboard
- THEN queue depth, ingest failure rate and search p95 are shown, with Workers Logs and traces enabled
