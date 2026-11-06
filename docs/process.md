# Process

Where planning lives and how work is tracked, so none of it depends on one session's memory. The design is `docs/ARCHITECTURE.md` and `docs/FRONTEND-DISCOVERY.md`. The acceptance criteria are `specs/scenarios/`. The gate is `.claude/skills/gate/SKILL.md`, tickets come from `.claude/skills/to-tickets/SKILL.md`, waves of items are run by `.claude/skills/orchestrate/SKILL.md`, items are built test-first by `.claude/skills/tdd/SKILL.md`, and `.claude/skills/escalate/SKILL.md` says what to do when unsure. Where this file and one of those disagree, that file wins and this one is fixed.

Adapted from the folio project's ledger.

## Where things live

| What | Where |
|------|-------|
| Design and decisions | `docs/ARCHITECTURE.md` (its *Decisions so far* table is binding), `docs/FRONTEND-DISCOVERY.md` |
| Acceptance criteria | `specs/scenarios/mvp/`, `specs/scenarios/later/` |
| Which issue is which work item | `docs/project-tracking.md` |
| Where each item is now | The ledger, https://claude.ai/artifact/TxUtdLCvqUiySs749b8sMn |
| The ledger page's source | `docs/ledger/page.html` |
| The ledger check | `scripts/ledger-check.mjs` |
| Running a wave of items | `/orchestrate`, with the agent types in `.claude/agents/` |

## Work items

- **One item is one issue, one branch, one PR.** It passes `/gate` before its PR opens and again before it merges.
- **Tickets are cut by `/to-tickets`.** Each issue's *Definition of done* cites scenario cases, and its `Depends on:` line names the issues that must merge first. The gate checks that each dependency is closed.
- **Order follows blockers.** Work the frontier: items whose blockers have all merged. Otherwise landing order doesn't matter, unless the operator marks an item critical.
- **Start an item only on the operator's word**, even when its blockers have cleared.
- **The orchestrator merges.** The operator ruled this on 2026-10-30, toward a dark factory, and it is their standing word to merge for `/gate` §6, for PRs built under `/orchestrate`. The builder takes its PR through the merge gate, and the orchestrator decides it is done and merges it:
  1. The builder opens the PR as a draft.
  2. The builder runs `/gate merge` on it. That runs the full review ladder for its tier and the handling of its findings (`/gate` §6). There is no Copilot review, by the operator's ruling. The builder pushes every fix, and replaces the PR body's *What was run* block with the merge gate's.
  3. A `/code-review` finding in the PR's scope is fixed in the PR, and the PR doesn't merge while one is open. The same goes for a real defect on the security boundary, wherever it came from. One the builder can't fix with confidence goes up `/escalate`.
  4. Every other finding becomes a bug issue, or a private advisory if it's a live exploit (*Working rules*), and the builder reports `ready`. That is the engineer's status, not GitHub's ready for review: the builder leaves the PR a draft and never merges.
  5. The orchestrator checks the PR (`/orchestrate` §5). If `main` has moved, it is brought in once, just before this PR merges, and the `/gate` §3 checks are rerun on the result. The orchestrator has an agent on a cheap model try the merge, which never resolves a conflict or fixes a check. A conflict or a failing check the PR caused goes back to the builder, with the ladder for a conflict it resolves by hand; a check `main` itself fails goes to the operator. Then the orchestrator marks the PR ready for review and merges it with `gh pr merge <n> --squash`, one PR at a time.
  Never use auto-merge or `--force`, and never push to `main`. Outside `/orchestrate`, a PR merges only when the operator says so.
- **Waves of items run under `/orchestrate`**, and every item is built test-first with `/tdd`.

## Working rules

For every agent and session working here, whatever skill it runs:

- **The repo is public.** No fic text, real epub contents or reader data in code, tests, fixtures, snapshots, commits, PRs, issues, notes or logs. Fixtures are named, never quoted.
- **A live exploit is never written up in public.** A finding is a live exploit when someone with no special access could use it on production today to take over an account, read private data (reader data, addresses, unpublished uploads, kept originals), run script on a reader's page, or change or remove someone else's work. So is a secret that has actually leaked; never quote it. A defect that needs a leaked secret, a future change or several failures at once first is not one, and stays a normal bug issue. When unsure, treat it as a live exploit.
  - Record it as a draft security advisory, not an issue: `gh api -X POST repos/rare-pair/app/security-advisories --input <scratchpad file>`, with `summary`, `description` and `vulnerabilities` set to `[{"package":{"ecosystem":"other","name":"rare-pair/app"}}]`. A draft is visible only to the repository's admins and whoever is added to it. Open issues, PR bodies and comments, commit messages and the ledger are public or shared, so none of them say how the attack works: a fix's PR says what changes, not how to exploit what it replaces.
  - Don't stop the wave for it. Give the advisory's link, with a neutral description, in your report. The operator hears of it there, and decides whether to publish it, and when it's fixed unless the merge gate already requires the fix (a real defect on the security boundary still blocks its PR). A leaked secret is the exception: tell the operator at once, because only they can rotate it.
- **Work outside the repo goes in a scratchpad.** Logs, screenshots, notes and scratch tests go in your session's scratchpad directory, or the scratch root a brief names. Never in the repo.
- **Worktrees share one git stash.** Never use bare `git stash`: set work aside with a WIP commit.
- **On Windows, run `.sh` scripts from Git Bash** (the Bash tool), never PowerShell, where `bash` may resolve to WSL (`/gate` §2).
- **Commit messages follow the style of `git log`.**
- **Stuck or unsure?** Follow `/escalate`. Open design questions go to the operator.

## The ledger

The ledger is a claude.ai page whose content is a shared database. Only editors write it, through the ArtifactData tool:
- `set` creates a document.
- `update`, guarded by `if_version`, changes one.
- `batch` sends several at once.

The page is never republished to change its data. `docs/project-tracking.md` stays the record of which issue is which item; the ledger records where each one is.

Collections, with the fields `docs/ledger/page.html` reads:

- **`lanes`**: id, name, scope, issue, order. A lane is a group of items, such as an area of the work.
- **`items`**: the doc id is the work-item id. Fields:
  - label?, lane, order, title, issue, pr[], status, gates[], model?, mergedAt, note
  - status is one of:
    - `queued` or `waiting` (Ready)
    - `building`, `running` or `blocked` (In progress)
    - `gating` or `review` (Testing)
    - `merged`, `done` or `closed` (Done; `closed` for an item that ended without merging)
  - `gates` names the items that must merge first: the issue's `Depends on:` line.
- **`agents`**: one doc per explorer, builder, consultant, gate or reviewer (the cheap agent that brings `main` in before a merge is a `gate`). Fields:
  - kind (`explorer`, `builder`, `consultant`, `gate`, or `reviewer` for an ad hoc review only, never the review agents inside `/gate merge`), name, item (or task, for work with no item), model, lane, step, pr[], startedAt, finishedAt, note
  - the doc id is `<item or task>-<kind>`, with `-<n>` added for the second and later of the same kind: `E1-explorer`, `E1-builder`, `E1-consultant-2`. A relaunched agent gets a new id, so the first one's row stays. For consultants, `n` counts every consult of the item, the engineer's own and the orchestrator's: query `agents` for the next free id before adding a row.
  - status is `running`, `idle`, `finished` or `failed`. An agent that may still be sent more work, such as a builder whose PR is open, is `idle`; it's `finished` once that can't happen (its PR merged, or the item closed).
- **`questions`**: one per open design question, with id `Q<n>`, title, state (`open` or `closed`), proceeding and note.
- **`reviews`**: the operator's task list, with title, detail, ref, url, order and state (`open` or `done`).
- **`followups`**: one per follow-up issue (adjacent problems and audit findings, not work items), with issue, title, note, status (`open`, `review`, `running` or `closed`), workspace, waitsOn[] and pr[]. A triage adds severity (`launch-blocker`, `high`, `medium` or `low`), lane (a `lanes` id, or `docs`), size (`XS`, `S`, `M` or `L`), needsOperator (true when it waits on the operator's decision) and duplicateOf (an issue number). The page sorts by severity and filters on all of them; a follow-up with no severity shows as not triaged.
- **`log`**: one document per day, `log/<YYYY-MM-DD>`, with `day` and `entries[{at, text}]`. Entries are appended to it, never one document per event.

The document `meta/state` holds `main` (short sha) and `updatedAt`, which the page header shows.

Rules:

- **When to update:** at every launch, report, merge, filed issue, question closure and operator ruling.
- **Who writes an agent's row:** the orchestrator, at launch and at report, for every field but two. A builder engineer writes only its own row's `step` and `note`, pinned with `if_version` (`.claude/agents/engineer.md`, *Your ledger row*). Explorers, consultants and the merge-main gate agent write nothing: the orchestrator keeps their `step`. The consults an engineer runs itself get their rows at its report, already `finished`. The review agents inside an engineer's `/gate merge` have no rows: the builder's `step` shows the round. `step` is the stage the page shows on a running or idle agent's card (stage names in `/orchestrate` §6).
- **Real times only:** every time on it comes from `date -u`, a commit, or GitHub's `mergedAt`. Never an estimate.
- **Before a status summary,** query `agents` for `running` and `idle` rows and reconcile them with what is actually running.
- **After every merge and every hand-back,** check the ledger against GitHub with `scripts/ledger-check.mjs`, from a checkout of this repository:
  1. Export `items`, `agents`, `followups` and `log` with ArtifactData `list`, with `out_dir` set to one new directory and `query.limit` 1000. Export `meta/state` with `get` into the same directory.
  2. Run `node scripts/ledger-check.mjs <dir>`. It prints every disagreement and exits 0 when there are none.
  3. If it names documents that `versions.json` lacks (exit 2), write `<dir>/versions.json` mapping each `"<collection>/<doc id>"` to the version the listing printed, and run it again.
  4. Send each entry of `batches` in `<dir>/changes.json` as one ArtifactData `batch`, in order. Every entry is pinned to a version, so a document changed since the export refuses its whole batch; export again and repeat.
  5. Settle by hand what it only reports, then log the run.
- **What the check writes:** only what GitHub decides, such as an item whose PRs merged becoming `merged` with the real `mergedAt`, a follow-up whose issue closed becoming `closed`, and `meta/state` getting `main`'s head. Everything else it only reports.
- **Changing the page:** edit `docs/ledger/page.html`, redeploy it to the ledger's URL with the Artifact tool, and commit the change.
