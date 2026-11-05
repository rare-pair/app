---
name: gate
description: Gate a work item on this repository against its issue's definition of done, before opening its PR or before merging it. Runs the standing checks, picks the protocols the diff needs (epub, db, ingest, web, content, mailer, integration, docs), runs live checks where the app can be launched, and writes the "What was run" block for the PR. Use for a work item, branch or PR here; for "does my change work in the running app" alone, use /verify or /run.
argument-hint: "[pr|merge] [issue number or branch]"
---

# Gate a work item

The mode comes from the arguments, and without one it is `pr`.

- **`pr`** runs §1–§5 and §7 on the branch, after committing, before the PR is opened.
- **`merge`** runs §1–§5 on the PR's pushed head, then §6. When the PR body's *What was run* block has a **Head:** line whose full sha equals `git rev-parse HEAD`, cite the §1–§5 results it lists as passed instead of running them again, and say so in the report. Never cite results from another commit: a block without a **Head:** line, or with a different or abbreviated sha, runs all of §1–§5, as does any head they haven't run on, such as one with a fix pushed after them, or one that merged `main` (§6.4). A check the block lists as failed runs again, and one it lists as not run is tried again and reported not run if it still can't run. After §1–§5, merge mode goes on to §6, and ends with §7's report, which replaces the PR body's *What was run* block. First check that the checkout has no uncommitted changes (`git status --short --untracked-files=no` prints nothing) and that `HEAD` is `origin/<branch>`.

Put any output whose path you choose (logs, screenshots, scratch tests) in your Claude Code session's scratchpad directory, in a subfolder named for the branch. Never in the repo.

The design this gate checks against is `docs/ARCHITECTURE.md`. Its *Decisions so far* table is binding: a diff that contradicts a row there is a stop event (§3), not a fix.

## 1. Read what must be true

- `gh issue view <n>`: copy its definition-of-done bullets and its `Depends on:` line, when it has one. Check each dependency is closed.
- No issue (a tooling or docs PR, say): take the scope the PR description or the operator's request states as the definition of done, and say "no issue" in the report. Don't invent bullets.
- Read the sections of `docs/ARCHITECTURE.md` the issue touches.
- A bullet you cannot check locally is reported **not run**, with the reason. That covers a deployed check, a Cloudflare or Neon account, or a sign-in only the operator can do. It is never dropped.

## 2. Classify the diff

```bash
bash .claude/skills/gate/classify.sh origin/main
```

From the PowerShell tool on Windows, `bash` may resolve to WSL, which fails with "not a git repository". Run it from the Bash tool, or call Git Bash by path: `& "C:\Program Files\Git\bin\bash.exe" .claude/skills/gate/classify.sh origin/main`.

It reads the commits since the merge base, plus uncommitted changes to tracked files. It ignores untracked files, so commit first. It prints the changed files' workspaces, then one protocol per line. Run every protocol it names. `bash .claude/skills/gate/classify.test.sh` checks every route. When the script reports no changes, there is nothing to gate: say so, and stop.

## 3. Standing checks (every protocol except `docs`)

Run from the repo root:

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

The root `package.json` defines these scripts. `lint` (oxlint with ai-deslop's rules, `oxlint.config.ts`) and `format:check` (oxfmt, `.oxfmtrc.jsonc`) run once from the root over every workspace and `scripts/`; `npm run format` fixes what `format:check` finds. The other three run in each workspace with `--if-present`, which silently skips a workspace that lacks the script: report that workspace's check **not run: not defined yet**, never pass. A cache hit is not a run: pass the tool's force flag when the runner caches.

When the protocols include `web` or `integration`, also run the browser suite, `npm run test:browser`, once `npm test` has finished: both start workerd, so don't run them together. It needs Playwright's Chromium, which `npm ci` doesn't download. If it's missing, don't install it: report it and stop, because the operator installs browsers.

A check that fails in a workspace the item should not have touched is a stop event, not a fix. Report it under *Deviations* with the failing output, and name the choice in the final report for the operator.

## 4. Protocols

### epub — `packages/epub` or `fixtures/` changed

The parser and sanitizer are the security boundary (ARCHITECTURE, *Sanitizing*). Its tests run in the Workers runtime (`packages/epub/vitest.config.ts`), since `HTMLRewriter` does not exist in Node.

- Every fixture's snapshot still matches, or each changed snapshot is listed in the PR with the reason. A snapshot updated without a reason is a failure.
- The hostile fixtures are still rejected with their codes: zip bomb, path traversal, missing OPF.
- A chapter count that disagrees with `Stats:` is not a rejection: parsing succeeds with a `chapter_count_mismatch` review reason, and the work goes live with the "may be imperfect" notice and lands in "Works to check" (ARCHITECTURE, *EPUB processor* step 5). Only a suspect replacement version is `held_for_review`.
- The XSS corpus passes: no `script`, `on*` attribute, `style`, `javascript:` or remote `src` survives in any field, summary and notes included.
- AO3 fields are matched by label text, never by CSS class. Search the diff's added lines in the preface parser for class selectors (`.`, `[class`) and account for each.
- Running the parser twice on the same file gives the same output.

### db — `packages/db` changed

- Migrations only ever add: none edits or deletes an earlier migration file.
- Apply every migration to an empty database, and report the output. A migration that drops or rewrites data names its reason in the PR.
- A new column the processor writes appears in ARCHITECTURE's *Data model*, or the PR says why not.

### ingest — `apps/ingest` changed, or anything `epub` covers

- The same upload delivered twice produces one work and one version (ARCHITECTURE, *EPUB processor*, Lease the job).
- Each job writes only under its own `works/<ao3_work_id>/<upload_id>/` prefix, plus content-hashed images under `works/<ao3_work_id>/img/` (ARCHITECTURE, *Why these pieces* and *EPUB processor* step 6).
- R2 is written before the Postgres transaction, and the work goes `live` last. A failure before the transaction leaves only files under the upload's prefix, plus any content-hashed images it wrote under `works/<ao3_work_id>/img/`, which the periodic sweep removes once no version references them.
- Each rejection code the diff touches has a test that reaches it, and the uploader-facing message says what happened in plain words.
- The versioning rules hold: a newer, consistent upload replaces; a newer upload that changes earlier chapters or the tags or authors is `held_for_review`; one that is not newer is `duplicate`. `held_for_review` and `duplicate` are statuses, not rejections: their files are kept. No uploader gets special treatment: there are no work claims while AO3 is down.
- The opt-out and takedown lists are checked before anything is written.

### web — `apps/web` changed

- Every HTML response carries the CSP from ARCHITECTURE, *Reading*, with a nonce that differs between two requests. No `<script>` lacks it. Only the Turnstile pages (`/login`, `/upload`, `/remove`, `/dmca`, and `/` and `/waitlist` while `PRELAUNCH` is on) add `frame-src https://challenges.cloudflare.com`; reader and work pages never do.
- Those pages show a `<noscript>` message with JS off. Reading, browsing, search and reader settings still work fully without JS.
- Chapter HTML reaches a page only from a sanitized fragment under `works/`, never from `uploads/` or `originals/`.
- Session cookies are `HttpOnly; Secure; SameSite=Lax` with no `Domain`, so they cover the app host only.
- Every response sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`, and any request to `www.rarepair.fans` gets a 308 to the same path and query on `rarepair.fans` (ARCHITECTURE, *Hosts*).
- Sign-in (ARCHITECTURE, *Auth*): our routes, not Better Auth, do these, because server-side `auth.api` calls skip its own checks:
  - `POST /login` and `POST /login/confirm` refuse with 403 a request with neither `Origin` nor `Sec-Fetch-Site`, a present `Origin` other than `https://rarepair.fans`, or a present `Sec-Fetch-Site` other than `same-origin`, so a sibling host such as `content.rarepair.fans` is refused too.
  - `next` is reduced to a same-site path, checked after URL normalization, so `/a/..//evil.example` can't become `//evil.example`.
  - Sign-in is rate limited per IP and per email.
  - `GET /login/confirm` spends no token and creates no session: only `POST /login/confirm` does. The link page may carry a script for the browser that asked for the link (it holds the sign-in marker): nonced, submitting the form at most once. Without the marker it has no script.
  - The sign-in marker holds nothing about the address, the token or the account, is `HttpOnly; Secure; SameSite=Lax; Path=/` with no `Domain`, lasts no longer than the link, and is set only by an accepted `POST /login`. Every answer of `POST /login/confirm` clears it.
  - Magic-link tokens stay in the Postgres `verification` table, never KV.
- A work rated Mature or Explicit, or with archive warnings, or with no rating (shown as "Not Rated"), shows the interstitial on first entry to its reading pages from any entry point (any chapter or `/full`), remembered per work for the session. Only signed-in readers can turn it off, and that choice is stored on the account.
- Login, upload and search are throttled when their rate limit is exceeded, and a spent upload quota is refused the same way: the response is 429 with `Retry-After` and a plain page saying when to try again (ARCHITECTURE, *Surge controls*, Status codes).
- Live check (§5): a browser journey walks each story the issue names, starting at the home page and following links. At 360 px wide the page does not scroll sideways (`document.documentElement.scrollWidth <= innerWidth`). For a visual change, record the journey with `BROWSER_RECORD` (README, *The browser suites*) into the scratchpad subfolder, at 1280 px and at 360 px with `BROWSER_VIEWPORT`, and list the paths.

### content — `apps/content` changed

- It serves images and original downloads only. Its `robots.txt` comes with #570. It never serves `text/html`.
- No response sets a cookie. Every response sends `X-Content-Type-Options: nosniff`. Downloads send `Content-Disposition: attachment`.
- No response is `Cache-Control: immutable`, because these files can go away (ARCHITECTURE, *Edge cache*). A removed work's paths return 404 after removal.

### mailer — `apps/mailer` changed

The mailer is the only Worker holding email-provider keys (ARCHITECTURE, *Auth*, Email).
- It only sends. It has no Hyperdrive, KV or R2 binding in its `wrangler` config.
- It sends through Resend's batch API. There is no failover provider at launch (operator's ruling, 2026-11-05). A test reaches each path with a stub sender, and no test calls a real provider.
- A batch Resend refuses as a whole (rate limit, quota, outage) is retried by the queue, then dead-lettered. A malformed message or a single refused address is acked and counted in the logs. It's never dropped silently. The dead-letter queue's retention is one day at most, and nothing prints its messages (address plus link) to logs.
- No log line contains an email address or a link. It logs provider message IDs and outcomes only.

### integration — anything else changed

Root configuration, `wrangler` configs, dependencies, `scripts/`, `.github` and the gate's own scripts can affect every Worker.

- Run every protocol above, and `bash .claude/skills/gate/classify.test.sh` when the classifier changed.

### docs — `docs/`, `*.md` or `.claude/` Markdown changed

- When docs is the only protocol printed, the standing checks are reported not run: docs only. Beside any other protocol, the standing checks run as usual.
- A change to `docs/ARCHITECTURE.md` keeps the *Decisions so far* table consistent with the sections below it. A section that now disagrees with the table is a failure.

### Every protocol

- **Branding.** Search the diff's added lines for `AO3`, `Archive of Our Own`, `archiveofourown` and `OTW`. Each hit must be a provenance link to a work's original URL, a parser label or pattern, a test fixture, or documentation. Any use in site name, logo, styling or copy that implies affiliation is a failure (ARCHITECTURE, opening).
- **Secrets.** No R2 keys, API tokens, Neon connection strings or email-provider keys in the diff. Search for `secret`, `token`, `postgres://`, `AKIA` and `-----BEGIN`, and account for each.
- **Reader privacy.** No new code logs an email address, an IP address next to a work ID, or a reading position.

## 5. Live checks

A live check runs the app and confirms the change against it. Here that is the browser suite (§3), which runs the web, ingest and content Workers in a real browser. A story the suite doesn't reach yet gets a new journey in the PR, starting at the home page and following links. The mailer isn't in the suite: its stories are shown by its own tests.

A bullet only a deployed environment can show, such as real R2, Queues, Turnstile or the live zone, is reported **not run**, with the reason.

## 6. Merge mode only: the merge gate

1. `git fetch`. Don't bring `main` in yet: §6.4 does it once, just before the merge, so the ladder reviews the branch's own work.
2. CI on the PR's head is green, or report it not run when the repo has no CI yet.
3. The review ladder below, scaled by the PR's risk tier. The operator may waive it or stop it at any rung. *What was run* names the tier and the rungs that ran. A rung starts once the fixes from the rung before are pushed. There is no Copilot review (operator's ruling).
4. Merge with `gh pr merge <n> --squash` only when the operator has said to merge. For a PR built under `/orchestrate`, the standing rule in `docs/process.md` (*Work items*, "The orchestrator merges") is that word, and only the orchestrator merges: a builder, or any agent launched to run this gate, never merges the PR. Bring `main` in once, just before the merge, if the branch doesn't contain it (`git merge-base --is-ancestor origin/main origin/<branch>`). It isn't needed after each other merge that lands meanwhile. Then rerun §3 on the merged head. Under `/orchestrate`, the orchestrator has an agent on a cheap model try the merge (`/orchestrate` §5), and the builder resolves a conflict. Otherwise whoever merges the PR brings it in, resolves a conflict, and adds a line to the PR's *What was run* block naming the merged head and the §3 results. A conflict resolved by hand goes through the ladder again. Then a draft is marked ready for review (`gh pr ready <n>`) by whoever merges.

**Risk tiers.** Each changed file gets a tier by the first rule it matches, checked from tier 3 down, and the PR takes the highest tier any file gets. When unsure, use the higher.

- **Tier 3, the full ladder: rungs 1 to 3, with three `/code-review` rounds.**
  - Executable process: `scripts/`, `.github/`, `.claude/settings*.json`, a hook, any script under `.claude/`.
  - Build and runtime configuration: a `wrangler` config, a dependency change in `package.json` or `package-lock.json`.
  - A migration under `packages/db`.
  - The security boundary: the sanitizer, the zip limits, the CSP, `apps/content`'s headers, presigned upload URLs, magic-link tokens and sessions, rate limits and quotas, and the opt-out, takedown and removal paths.
  - A test change that removes or loosens an assertion guarding any of these.
  - Any file no lower tier names, such as root configuration.
- **Tier 1: rungs 1 and 3, with one `/code-review` round** on specification completeness: `docs/ARCHITECTURE.md`, other design documents under `docs/`, and `.claude/skills/` Markdown.
- **Tier 2: rungs 1 and 3, with one `/code-review` round** on correctness: a test change that adds or tightens tests, or a code change of at most 50 changed lines (added plus deleted, tests excluded) in one workspace. Any larger code change is tier 3.
- **Tier 0: rung 1 only.** `README.md` and other prose that binds nothing.

**The rungs:**

1. This skill, §1–§5: in `merge` mode, the run that started this gate.
2. `/simplify`. It reports first, then apply the worthwhile findings and push them before rung 3. Say in the report which you applied and which you left, and why.
3. `/code-review` rounds, as many as the tier names, each with its own error class. The specification-completeness class checks every field at its edge values (empty, zero, maximum and one past it), every absolute claim ("every", "always", "never") for truth, each limit multiplied out to its worst case, repeated and concurrent operations, and agreement with the *Decisions so far* table.

Before any rung, read what is already on the PR: `gh api --paginate repos/rare-pair/app/pulls/<n>/reviews`, `.../pulls/<n>/comments` and `.../issues/<n>/comments`. Confirm each round's fixes against a numbered list of every earlier finding, each marked resolved, moot or open. Fix `/code-review` findings in the PR's scope in the PR, and it doesn't merge while one is open; one you can't fix with confidence goes up `/escalate`. So does a real defect on the security boundary, or one that means a *Definition of done* bullet doesn't hold, wherever it came from: it blocks the merge too. File other findings outside the PR's scope as issues linked to the PR. A fix on the security boundary made after the last round gets one more `/code-review` round. After the last fixes, rerun the §3–§5 checks those fixes touch.

## 7. The report

End with this block. It fills the PR's *What was run* section:

```markdown
**Protocols:** <from classify.sh>

- **Head:** <the full sha of the commit §1–§5 ran on in full, or were cited from; a later push, such as a ladder fix or a merge of `main`, doesn't change it, so a later `/gate merge` on the pushed head reruns §1–§5 in full; the push is listed under Ran with the checks it was given>
- **Ran:** <each command or observation, with its result: pass or fail>
- **Live checks:** <the browser suite's result, and the journeys this PR added, or "none">
- **Not run:** <each check, with the reason>
- **Screenshots:** <paths, or "none">
- **Deviations:** <each stop event from §3 or §4, with its output and the choice for the operator, or "none">

**Definition of done**
- [x] <bullet> — <the test or observation that shows it>
- [ ] <bullet> — not run: <reason>
```

A check that failed is reported as failed, with its output, even if a rerun passed. Report the passing rerun alongside it, and list the test as flaky. Say whether CI ran.
