# Scenario: A moderator's "Not NSFW" sticks

Relates to: specs/scenarios/later/09-nsfw-sign-in-gate.md (NSFW reports); specs/scenarios/mvp/17-reports-and-dmca.md; specs/scenarios/mvp/18-moderation.md

Backlogged from spec 09 at the operator's request, 2026-11-06. Until this is built, a moderator's "Not NSFW" lifts the mark and closes the open reports, and 3 new reports can gate the work again. This builds on spec 09 and waits for it.

## Setup
- A work's NSFW mark gains a fourth value, `cleared`: a moderator said it isn't NSFW
- A live work G, rated General Audiences with no archive warnings, and signed-in accounts U1, U2 and U3

## Cases

### Clearing a work records the decision
- GIVEN work G with a `reported` mark and open `nsfw` reports
- WHEN a moderator uses "Not NSFW"
- THEN the mark becomes `cleared`, and everything else happens as in spec 09

### A cleared work stays open whatever is reported
- GIVEN work G with a `cleared` mark
- WHEN U1, U2 and U3 each report it as NSFW
- THEN the reports are stored and listed for a moderator, and G's mark doesn't change

### A moderator can still change their mind
- GIVEN work G with a `cleared` mark
- WHEN a moderator uses "Mark NSFW"
- THEN the mark becomes `confirmed`, and G is gated

### A cleared mark outlives a version
- GIVEN work G with a `cleared` mark
- WHEN a new version goes live, or a moderator makes an older version current
- THEN the mark stays `cleared`

### A cleared mark can't open a gated work
- GIVEN a work rated Explicit with a `cleared` mark
- WHEN a signed-out visitor opens a chapter
- THEN it is gated by its rating, as in spec 09
