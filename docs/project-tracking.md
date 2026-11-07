# Project tracking

How the work is tracked in GitHub, and which issue is which work item. This file is the record of identity. Where each item stands now is on the ledger (`docs/process.md`, *The ledger*).

## How items are made

- **One item is one issue, one branch, one PR.** The `/to-tickets` skill cut them from `specs/scenarios/`. Every scenario case belongs to exactly one item, and an item's *Definition of done* lists its cases.
- **IDs are by area:**
  - W web skeleton, D database, M mailer, C content Worker, O ops, S site chrome
  - A auth, U upload, E `packages/epub`, I ingest
  - R reading, B browse, SR search
  - X requests, reports and removal; XR removal; MOD moderation
  - WL coming-soon page and wait list
  - Q quality sweep, L later
- **Depends on** comes from each issue's `Depends on:` line, which `/gate` checks is closed. If a dependency is wrong, correct it in the issue and here in the same PR.
- **Reused issues:** E2, E3 and E7 are the earlier issues #5, #4 and #6, rewritten into the ticket template. OXC is #11, filed separately.

The breakdown was cut on 2026-10-30, from `main` at `ee0b9c7`: 72 items covering 406 scenario cases, plus #11. The *Wait list* lane (WL1 to WL6, the 26 cases of `specs/scenarios/mvp/22-waitlist.md`) was added the same day, from `main` at `62c27a9`.

## Items

| Lane | Item | Scope | Depends on | Issue |
|------|------|-------|------------|-------|
| Foundations | W1 | Web Worker skeleton with the strict CSP | — | [#13](https://github.com/rare-pair/app/issues/13) |
| Foundations | D1 | packages/db with Better Auth's tables | — | [#14](https://github.com/rare-pair/app/issues/14) |
| Foundations | M1 | Mailer Worker on the email queue | — | [#15](https://github.com/rare-pair/app/issues/15) |
| Foundations | D2 | Catalogue and uploads schema, with a seeded-work test helper | D1 | [#16](https://github.com/rare-pair/app/issues/16) |
| Foundations | D3 | Requests, reports and moderation schema, with pseud_norm | D2 | [#17](https://github.com/rare-pair/app/issues/17) |
| Foundations | S1 | Shared layout and site chrome | W1 | [#18](https://github.com/rare-pair/app/issues/18) |
| Foundations | C1 | Content Worker for images and original downloads | — | [#19](https://github.com/rare-pair/app/issues/19) |
| Foundations | O1 | R2 bucket rules: CORS for the app origin, 7-day expiry on uploads/ | — | [#20](https://github.com/rare-pair/app/issues/20) |
| Auth | A1 | Request a sign-in link | W1, D1, M1 | [#21](https://github.com/rare-pair/app/issues/21) |
| Auth | A2 | Confirm a sign-in link and start a session | A1 | [#22](https://github.com/rare-pair/app/issues/22) |
| Auth | A3 | Sign-in rate limits and the shared 429 page | A1 | [#23](https://github.com/rare-pair/app/issues/23) |
| Auth | A4 | One-time terms page for new accounts | A2 | [#24](https://github.com/rare-pair/app/issues/24) |
| Upload & ingest | U1 | Upload request: presigned PUT URL | A2, D2 | [#25](https://github.com/rare-pair/app/issues/25) |
| Upload & ingest | U2 | Confirm an upload (HEAD, size, hash, duplicate shortcut, enqueue) | U1 | [#26](https://github.com/rare-pair/app/issues/26) |
| Upload & ingest | U3 | Upload page script: direct PUT with progress, several files | U2, O1 | [#27](https://github.com/rare-pair/app/issues/27) |
| Upload & ingest | U4 | Daily upload quotas (new and trusted tiers) | U1, A3 | [#28](https://github.com/rare-pair/app/issues/28) |
| Upload & ingest | U5 | Upload request rate limits | U1, A3 | [#29](https://github.com/rare-pair/app/issues/29) |
| Upload & ingest | U6 | Upload status endpoint and My uploads | U1 | [#30](https://github.com/rare-pair/app/issues/30) |
| Upload & ingest | I1 | Ingest consumer: lease, process, reject, dead-letter | D2 | [#31](https://github.com/rare-pair/app/issues/31) |
| Upload & ingest | I2 | Save a new work: R2 first, one transaction, live last | I1 | [#32](https://github.com/rare-pair/app/issues/32) |
| Upload & ingest | I4 | Versioning: replace, hold or mark duplicate | I2 | [#33](https://github.com/rare-pair/app/issues/33) |
| Upload & ingest | I5 | Opt-out and takedown checks at ingest | I1, D3 | [#34](https://github.com/rare-pair/app/issues/34) |
| Upload & ingest | U7 | Hash matches that get no shortcut, end to end | U2, I4, I5 | [#35](https://github.com/rare-pair/app/issues/35) |
| Upload & ingest | E1 | Unzip limits and package structure: edge-case tests | — | [#36](https://github.com/rare-pair/app/issues/36) |
| Upload & ingest | E2 | Read the EPUB3 nav table of contents | — | [#5](https://github.com/rare-pair/app/issues/5) |
| Upload & ingest | E3 | Rewrite internal chapter links to reader URLs | R2 | [#4](https://github.com/rare-pair/app/issues/4) |
| Upload & ingest | E4 | Preface and chapter-boundary test gaps | — | [#38](https://github.com/rare-pair/app/issues/38) |
| Upload & ingest | E5 | Sanitizer allowlist and image checks: full case coverage | — | [#39](https://github.com/rare-pair/app/issues/39) |
| Upload & ingest | E6 | Fuzz the sanitizer with an XSS corpus | — | [#40](https://github.com/rare-pair/app/issues/40) |
| Upload & ingest | E7 | Real multi-chapter and long-work fixtures | — | [#6](https://github.com/rare-pair/app/issues/6) |
| Upload & ingest | I3 | Store epub images under the work's img prefix | I2 | [#41](https://github.com/rare-pair/app/issues/41) |
| Upload & ingest | I6 | Review reasons and held versions, end to end | I4, U6, R4, MOD3 | [#48](https://github.com/rare-pair/app/issues/48) |
| Upload & ingest | I7 | Re-sanitize backfill queue | I3, I4 | [#49](https://github.com/rare-pair/app/issues/49) |
| Reading | R2 | Chapter reader | W1, D2, S1 | [#37](https://github.com/rare-pair/app/issues/37) |
| Reading | R1 | Work page | W1, D2, S1 | [#42](https://github.com/rare-pair/app/issues/42) |
| Reading | R4 | Entire work view and the reader notice | R1, R2 | [#43](https://github.com/rare-pair/app/issues/43) |
| Reading | R3 | Hidden and removed works: 451 and 410 | R4 | [#50](https://github.com/rare-pair/app/issues/50) |
| Reading | R5 | Reader settings (cookie, no-JS form, live script) and flash messages | R2 | [#51](https://github.com/rare-pair/app/issues/51) |
| Reading | R6 | Saved reading position and "Continue where you left off" | R1, R4, A2 | [#52](https://github.com/rare-pair/app/issues/52) |
| Reading | R8 | Rating and warnings interstitial | R4 | [#53](https://github.com/rare-pair/app/issues/53) |
| Reading | R7 | Fragment caching and edge-cached reader pages with a fresh nonce | R8 | [#54](https://github.com/rare-pair/app/issues/54) |
| Reading | R9 | Signed-in readers can turn the warnings screen off | R8, R5, A2 | [#55](https://github.com/rare-pair/app/issues/55) |
| Discovery | B1 | Work card on the tag listing | W1, D2, S1 | [#56](https://github.com/rare-pair/app/issues/56) |
| Discovery | B2 | Listing pagination, sort and filters | B1 | [#57](https://github.com/rare-pair/app/issues/57) |
| Discovery | B3 | Home page | B2 | [#58](https://github.com/rare-pair/app/issues/58) |
| Discovery | SR1 | Metadata search | B1, I2 | [#59](https://github.com/rare-pair/app/issues/59) |
| Discovery | SR2 | Search rate limits | SR1, A3 | [#60](https://github.com/rare-pair/app/issues/60) |
| Removal & moderation | MOD1 | Admin area: moderator gate and the four queues | A2, D3 | [#44](https://github.com/rare-pair/app/issues/44) |
| Removal & moderation | MOD4 | Work admin page: every version and Make current | MOD1 | [#45](https://github.com/rare-pair/app/issues/45) |
| Removal & moderation | X4 | Report a work | R1, A2, D3 | [#46](https://github.com/rare-pair/app/issues/46) |
| Removal & moderation | MOD3 | Works to check queue and its actions | MOD4, I4, X4, R4 | [#47](https://github.com/rare-pair/app/issues/47) |
| Removal & moderation | X1 | Remove-my-work form and request intake | A1, D3, R1 | [#61](https://github.com/rare-pair/app/issues/61) |
| Removal & moderation | X2 | A removal request hides the work, once its requester confirms it | X1, R3, B3, SR1 | [#62](https://github.com/rare-pair/app/issues/62) |
| Removal & moderation | X3 | An opt-out hides every work by the pseud, once its requester confirms it | X2 | [#63](https://github.com/rare-pair/app/issues/63) |
| Removal & moderation | X5 | Removal request rate limits | X1, A3 | [#64](https://github.com/rare-pair/app/issues/64) |
| Removal & moderation | X7 | Reports from three accounts hide a work | X4, R3 | [#65](https://github.com/rare-pair/app/issues/65) |
| Removal & moderation | MOD2 | Queue detail pages; hide and restore | MOD1, R3 | [#66](https://github.com/rare-pair/app/issues/66) |
| Removal & moderation | X6 | Block a requester | X3, X7, MOD2 | [#67](https://github.com/rare-pair/app/issues/67) |
| Removal & moderation | X8 | DMCA notice form | D3, S1 | [#68](https://github.com/rare-pair/app/issues/68) |
| Removal & moderation | MOD5 | Request actions: related requests, bulk restore, opt-out review | MOD2, X3 | [#69](https://github.com/rare-pair/app/issues/69) |
| Removal & moderation | MOD6 | Ban an uploader | MOD2, U1, X4 | [#70](https://github.com/rare-pair/app/issues/70) |
| Removal & moderation | XR1 | Remove a work for good: delete from R2 and purge caches | MOD2, C1, R3, I3 | [#71](https://github.com/rare-pair/app/issues/71) |
| Removal & moderation | XR2 | Approving a removal request or takedown removes the work | XR1, X2, X8, I5 | [#72](https://github.com/rare-pair/app/issues/72) |
| Ops & quality | O2 | Periodic sweep of unreferenced images and orphaned version prefixes | I3 | [#73](https://github.com/rare-pair/app/issues/73) |
| Ops & quality | O3 | Surge load test: an upload flood becomes a backlog | U3, I2, R2, B2, SR1 | [#74](https://github.com/rare-pair/app/issues/74) |
| Ops & quality | O4 | Operations dashboard | I1, SR1 | [#75](https://github.com/rare-pair/app/issues/75) |
| Ops & quality | Q1 | Accessibility and no-JS sweep | A4, U3, U6, R6, R7, R9, B3, SR2, X2, X3, X4, X5, X8, MOD3, MOD5, MOD6, XR2 | [#76](https://github.com/rare-pair/app/issues/76) |
| Wait list | WL1 | Coming-soon page and the pre-launch mode | W1 | [#131](https://github.com/rare-pair/app/issues/131) |
| Wait list | WL2 | Join the wait list | WL1, D1, M1 | [#132](https://github.com/rare-pair/app/issues/132) |
| Wait list | WL3 | Confirm a wait list address | WL2 | [#133](https://github.com/rare-pair/app/issues/133) |
| Wait list | WL4 | Wait list rate limits | WL2, A3 | [#134](https://github.com/rare-pair/app/issues/134) |
| Wait list | WL5 | The launch send, with one-click unsubscribe | WL3, MOD1 | [#135](https://github.com/rare-pair/app/issues/135) |
| Wait list | WL6 | Open the archive and delete the wait list | WL5, S1 | [#136](https://github.com/rare-pair/app/issues/136) |
| Tooling | OXC | Adopt Oxc (oxlint + oxfmt) with the ai-deslop rules | — | [#11](https://github.com/rare-pair/app/issues/11) |
| Later | L1 | FanFicFare epubs of AO3 works (later) | I4, I5 | [#77](https://github.com/rare-pair/app/issues/77) |
| Later | L2 | Bulk upload from a zip of epubs | U3, U4, U6 | [#78](https://github.com/rare-pair/app/issues/78) |
| Later | L3 | Tag synonym merging (later) | B2, MOD1 | [#79](https://github.com/rare-pair/app/issues/79) |
| Later | L4 | Exclude tags in listing filters (later) | B2 | [#80](https://github.com/rare-pair/app/issues/80) |
| Later | L5 | Operator wind-down: redirect works to AO3 (later) | R1, R4 | [#81](https://github.com/rare-pair/app/issues/81) |

## Follow-ups

These are adjacent problems and decisions, not work items. They're tracked on the ledger as follow-ups:
- [#3](https://github.com/rare-pair/app/issues/3): the epub limits against 128 MB of Worker memory. This needs the operator's decision.
