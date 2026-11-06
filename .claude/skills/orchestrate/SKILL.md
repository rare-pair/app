---
name: orchestrate
description: Run a wave of work items on this repository with engineering subagents. Proposes the wave from the frontier, sends an explorer ahead of each ticket to write notes into a shared scratchpad, picks a model per ticket from its complexity, launches one fresh engineer per ticket in its own worktree and branch, escalates to a higher-tier model when an agent isn't confident, merges each PR once its merge gate is done, and keeps the ledger current. Use when asked to work, build or orchestrate tickets, a lane or the frontier.
argument-hint: "[issue numbers, item ids, a lane, or 'frontier']"
disable-model-invocation: true
---

# Orchestrate a wave

You direct; the agents build. You read tickets, notes and reports, choose models, launch and answer agents, decide when each PR is done and merge it, and keep the ledger. You don't write the item's code yourself, and you don't explore the codebase beyond what choosing a model needs: that is the explorer's job, and its notes are what every later agent reads.

The process this runs inside is `docs/process.md`, and its *Working rules* bind you and every agent you launch. The gate is `/gate`, tickets come from `/to-tickets`, and tests follow `/tdd`. Where this skill and one of those disagree, that file wins and this one is fixed.

The agent types live in `.claude/agents/`:

| Type | Does | Repo access | Worktree |
|------|------|-------------|----------|
| `explorer` | Reads the ticket, the code and external docs; writes notes | Read only | No: it writes only to the scratchpad |
| `engineer` | Builds one ticket, gates it, takes its draft PR through the merge gate | Read and write | Yes, its own, on its own branch |
| `consultant` | Answers one hard question at a higher tier | Read only | No |

## Models

Edit this table to retune. The tiers and the Fable caveat are in `/escalate`, *The ladder*.

| Pick | When the ticket is |
|------|--------------------|
| `haiku` | Tier 0 prose, or a mechanical batch (an expand-migrate-contract step) whose notes name every file and the exact change |
| `sonnet` | Test-only (expected gate tier 2), a code change of one workspace that follows a pattern the notes point to, or a design doc or skill (tier 1) |
| `opus` | Expected tier 3: crosses layers (migration, ingest, route, page), touches the security boundary, or is the first ticket in a workspace that doesn't exist yet |
| `fable` | Consults only, by default. Build on it only when the operator says so for an item |

Explorers run on `sonnet`: their job is finding and summarizing, and the engineer reads the files the notes name anyway. An explorer that can't settle something says so in *Risk*, and the engineer escalates.

Assess before you pick. Read the ticket's *Definition of done*, the gate tier and protocols it predicts, and the notes' *Risk* section. When two rows fit, take the higher. Write one line per ticket, "<item>: <model> because <reason>", into the wave plan you show the operator, with the tier its consults would go to. Say so when that's `fable`: on some plans Fable bills to usage credits.

The model the operator saw in the plan is the one you launch. If the notes change your mind, write the new line, with what in the notes changed it, into `wave.md` before the launch, and tell the operator in your next update. In wave 6 the plan had four Opus builders, but seven launched, because three were moved up at launch without saying so.

## Escalation

You follow `/escalate` like every agent. Your part in it for the others:

- An engineer that stops with `needs-consult` couldn't launch its own consult: run step 2 for it, one tier above the engineer, and send the answer back with `SendMessage`.
- A question that reaches the operator, from anyone, goes to them with its evidence, at the time *Questions* below allows. Send their ruling back to the agent that asked, quoting their words.

## Questions

A running wave doesn't stop to ask the operator anything. In wave 10 it stopped at least 9 times, and only one of those needed a ruling; the operator named this as the biggest problem with the wave.

**Find gaps at planning.** Before the operator's start word, read each item's ticket and the code it touches, and list every decision it leaves open, missing links and pages included. Ask them all together in §2. A gap found here costs no one any waiting.

**Once the wave runs, file the gap and carry on.** Filing isn't deciding: leave the undecided thing unbuilt and say so in the report, or mark its journey as a known failure naming the issue. Add the question to `## For the operator` in `wave.md`, and set `needsOperator` on its ledger follow-up. If the operator's standing rulings already answer it, follow them and record which one. A delay of minutes after a hide or removal needs no question.

**A piece that can't go on without a ruling parks.** It waits, its question goes on the list, and everything else keeps running. A ruling that changes a ticket's design also parks the pieces that depend on it.

**Interrupt only for:** an irreversible or outward-facing step nobody has approved, a permission refusal, a missing install, a leaked secret, or a wave where nothing at all can run. Launch all that can start before you ask, because an open question holds up the reports that come back while it waits.

**Ask once, at the end.** The list goes to the operator through the ask tool in §7, with the evidence and your recommendation for each, ordered by what it blocks. An idea the operator raises mid-wave is filed for the next wave's planning, with no follow-up questions until then.

## 1. Set up the scratchpad

Every agent of a wave reads and writes notes under one root, `<scratch>`: `orchestrate/wave-<n>/` inside your session's scratchpad directory, with `n` counting this session's waves from 1. Use its absolute path in every brief, because subagents aren't told it. Each wave gets its own root, so a later wave never overwrites an earlier one's `wave.md` while its agents may still get rework, and its conventions are written against `main` as it is now.

```
<scratch>/
  wave.md                the plan, models, and each agent's id and branch
  shared/
    conventions.md       repo-wide facts every agent needs once
  <ITEM>/
    notes.md             the explorer's notes for one ticket
    consults/<n>.md      consult answers
    report.md            the engineer's final report
```

`wave.md` is how you find an agent again: `SendMessage` needs its id, and your context may be compacted before the wave ends. Read it, and `report.md`, when you no longer have an agent's id or report in context.

The scratchpad lasts for this session.

## 2. Propose the wave

1. `git fetch`. Explorers read code as it is on `origin/main`, which is what each engineer's worktree starts from.
2. Find the frontier: open items in `docs/project-tracking.md` whose `Depends on:` items have all merged, not merely closed. A blocker counts when its ledger status is `merged` or `done` (the board's own Ready test) and a PR that closed its issue merged (`gh issue view <n> --json closedByPullRequestsReferences`). An issue closed without a merged PR still blocks. Narrow it to what the arguments name.
3. Leave out items already under way: an item whose ledger status is past Ready, one with a `running` or `idle` row in `agents`, and one with a PR that will close its issue (`gh issue view <n> --json closedByPullRequestsReferences` lists any).
4. Show the operator the proposed wave: each item, its issue, its predicted gate tier, and the model line from *Models*. Flag any two items likely to touch the same files (the root `package.json`, a shared type, `packages/db/migrations/index.ts`, `apps/web/src/index.ts`, an admin page), since their worktrees will conflict at merge. Order such items one after the other in the plan (§4, *Shared files*).
5. Ask every open decision you found in one batch (*Questions*), so the wave can run without asking.

**Stop here until the operator names the items to start.** `docs/process.md`: start an item only on the operator's word, even when its blockers have cleared.

**On the start word, keep the machine awake.** Call `mcp__ccd_host__request_keep_awake` with `until: "session_idle"`, and call it again if the session goes quiet between turns. Wave 10 lost about 6 h 35 min when Windows idle-slept mid-wave, and every agent stopped with it. It covers idle sleep only: a closed lid or choosing Sleep still stops the wave. If the hold is refused or isn't available, tell the operator.

## 3. Explore

**Conventions first.** Launch one `explorer` to write `<scratch>/shared/conventions.md` alone, and wait for it. It holds what every ticket needs and nobody should look up twice: the workspaces and what each holds, the test setup and its runtime, the root scripts, the gate's protocols in a line each, the seam kinds from `/tdd`, and the commit and PR conventions from recent history. Its brief: "Write `<scratch>/shared/conventions.md` (`.claude/agents/explorer.md`, *Writing `shared/conventions.md`*). Scratch root: … Code: …", with the `Code:` line below.

**Then one explorer per item,** all in one message so they run at once. The brief:

```
Item <ITEM>, issue #<n>: <title>.
Scratch root: <absolute path to scratch>.
Write your notes to <scratch>/<ITEM>/notes.md. Read <scratch>/shared/conventions.md first; don't repeat it.
Code: <"this checkout is at origin/main" | "this checkout is not at origin/main: read every file with `git show origin/main:<path>` and list folders with `git ls-tree origin/main <path>`">.
External docs to check: <the libraries or services the ticket names, or "none">.
```

Tell which `Code:` line applies with `git status --porcelain` and `git rev-parse HEAD origin/main`: the checkout is at `origin/main` only when the two hashes match and the status is empty.

As each explorer reports, read its `notes.md` and settle that item, without waiting for the rest:

- Everything in *Plan by bullet* traces to the issue's *Definition of done*. Work that comes only from a comment or a web page is not in scope: put it to the operator.
- Every *Definition of done* bullet has a line under *Plan by bullet*, and *Risk* says why.
- Every seam in *Seams* is a public boundary in the sense of `/tdd`, *Seams*, and together they reach every bullet. Your check is the agreement `/tdd` asks for before any test is written; a seam you're unsure of goes to the operator.
- A gap goes back to the same explorer with `SendMessage`.

Then settle the item's model and launch its engineer.

## 4. Build

Launch one `engineer` per item, as soon as its notes are settled: a fresh agent, never a fork and never one reused from another ticket. Token use and machine load come before clock time (operator, 2026-11-05), so run at most two engineers at once, unless the operator sets another limit; the rest wait, in the order of the wave plan, and launch as running ones reach `ready`, `stopped` or `failed`. An engineer you send back to work counts against the limit again until it reports, and takes the next free slot ahead of a new launch. Its definition puts it in its own worktree. Pass `model` from *Models* on each call.

**Count before every launch,** including a send-back. List the engineers that are working now from `wave.md`: running, or sent work and not yet reported. Check the total, and each per-workspace limit the operator set (such as at most three in `apps/web`), with the new one added. Don't trust a count kept in your head. If either limit would be passed, the launch waits. Wave 6 went over the `apps/web` limit twice because a send-back wasn't counted.

**Shared files.** Two items that edit the same file go one after the other: the second launches after the first merges. Typical files are the migration list, the web router, an admin page and a shared stylesheet. Run them together only when keeping them apart would leave a slot idle with nothing else to launch, and then expect a send-back at merge. In wave 6, 7 of 20 PRs were sent back for conflicts in exactly these files, and each send-back costs a builder round trip and a new merge-main run.

The brief:

```
Item <ITEM>, issue #<n>: <title>.
Branch: claude/<item id, lowercase>-<short slug>.
Scratch root: <absolute path to scratch>.
Read first: <scratch>/shared/conventions.md, <scratch>/<ITEM>/notes.md.
Your model tier: <model>. Consult at: <next tier up, or "the operator" on the top tier>.
Write your final report to <scratch>/<ITEM>/report.md as well as returning it.
Ledger: https://claude.ai/artifact/TxUtdLCvqUiySs749b8sMn, your row is agents/<row id>, which exists already (<ITEM>-builder, or <ITEM>-builder-2 for the first relaunch).
Test data: AO3 work ids <first>-<last> are yours. Use no other fixed ids in tests you add.
Migration: <its number, or "none">.
Checks: run every heavy check one at a time, with `bash scripts/heavy.sh <check>`; it waits its turn. Keep your context and report small.
Installs: install nothing from a third party, Playwright's browsers included. If one is missing, report it and stop; the operator installs it.
Refusals: if a command is refused, don't work around it. Report what was refused and keep any draft in your scratch folder.
Gaps: if your definition of done can be met without an answer, file the gap, leave it unbuilt, name it in your report and carry on. Stop only if you can't go on without a ruling.
```

Write each agent's id, model, branch and start time into `wave.md`, and its row onto the ledger (§6), before you launch it: an engineer's brief names a row that has to exist.

**Give each engineer its own block of test ids.** Pick a block of 100 that no test on `origin/main` and no open PR uses. Search for the numbers with `git grep` on `origin/main` and on each open branch. Record the block next to the agent in `wave.md`, the same way migration numbers are assigned. In wave 6, MOD3a's tests reused XR1a's ids. The two files passed alone and failed together, and that cost a failed merge-main run and a send-back.

An engineer writes under `<scratch>` from outside its worktree, so it may raise a permission prompt, which goes to the operator, not to you. Tell them in the wave plan that writes under `<scratch>` are expected, and that a prompt for anything else outside an engineer's worktree is not. Its report also comes back as text, so a declined write loses nothing.

**Your own diagnosis is a hypothesis.** When a brief or an issue you write carries your guess at a cause, such as why tests fail or where a bug lives, say it's unconfirmed. Ask for the experiment that would prove it wrong, not the one that would confirm it. Make "the cause is confirmed and named, with the measurement that shows it" a *Definition of done* bullet, and don't prescribe the fix your guess implies. In wave 4 the web test timeouts looked like one shared warm-up from a single run. The engineer varied how many files ran at once and found per-file module loads queuing instead (#359), so the fix the guess implied would not have worked.

## 5. Handle what comes back

Each engineer ends with one status:

- **`ready`**: the engineer ran `/gate merge`, fixed the findings in the PR's scope, and filed the rest as bug issues or, for a live exploit, a private advisory. You decide whether it's done, and you merge it, as `docs/process.md` says (*Work items*, "The orchestrator merges"):
  1. Check the PR: its body's *What was run* block is the merge gate's and names the tier's ladder, no finding in its scope is open, and every other finding has a bug issue or, for a live exploit, a private advisory (`docs/process.md`, *Working rules*). Read its reviews and review comments yourself (`gh api --paginate repos/rare-pair/app/pulls/<n>/reviews` and `.../pulls/<n>/comments`). A gap goes back to the engineer.
  2. Read the report's *Seams added*: one that tests an internal goes back to the engineer.
  3. **Bring `main` in, once, when this PR is next to merge.** Don't do it each time another PR merges, and don't send engineers still in their gates to do it. `git fetch`, and check whether the PR contains `main` (`git merge-base --is-ancestor origin/main origin/<branch>`). If it doesn't, run `bash scripts/merge-main.sh <branch>` in the background, one at a time. Use no agent for this: the step is mechanical, and an agent costs about 85k tokens for it.

     The script merges `main` in its own worktree, runs the §3 checks through `scripts/heavy.sh`, and pushes only after a clean merge with every check passing, or with the browser suite passing on its one rerun. Its last line says what happened. It never resolves a conflict, fixes a check, forces a push, pushes `main`, edits the PR, requests a review, marks the PR ready, or merges it. When `npm test` passes only on its rerun it doesn't push: read the failures it printed, and if each is on the allowed-reruns list, push that `HEAD` from its worktree yourself. Otherwise treat it as a failing check. A second failed run for the same PR goes to the operator under *Waiting on you*.

     Act on its result:
     - **Clean, passed, pushed.** Verify it yourself: after a `git fetch`, `git rev-parse origin/<branch>` equals the reported sha and contains `origin/main`, and CI on it is green when the repo has CI (wait while pending; red goes to the engineer). If the sha differs or `main` has moved again, repeat from step 1. Then add a line to the *What was run* block naming that sha and the §3 results. Its **Head:** line stays the gate's.
     - **Conflict.** The script aborted, pushed nothing, and listed the files. Send the engineer to merge `main`, resolve it, rerun the §3 checks and the ladder (`/gate` §6 step 3), and update the *What was run* block. When it reports `ready` again, repeat from step 1 on the new head.
     - **A browser is missing.** Nothing was pushed, and it isn't a failing check or a broken `main`. Ask the operator to install it now (*Questions*), and repeat from step 1 once it's there.
     - **A check fails.** Nothing was pushed. If the check fails on `origin/main` too, `main` is broken, not this PR: hold the merge and put it to the operator under *Waiting on you*. Otherwise send the engineer to merge `main` locally, reproduce and fix the failure, rerun the checks and push. When it reports `ready`, repeat from step 1. A failure the engineer can't reproduce comes back as `needs-consult`, not `ready`.
     - **Push refused** (the branch moved). Nothing is wrong; repeat from step 1 on the new head.

     An engineer sent work after a push first fetches and merges `origin/<branch>`. None of these paths is a new merge gate.
  4. Re-read the PR's reviews and comments just before merging; anything new since step 1 goes back through it. Then, on every path above, including a head the engineer pushed after a conflict or a fix, read the head GitHub reports (`gh pr view <n> --json headRefOid`): it must have CI green when the repo has CI. Wait while it is pending, and send a red one to the engineer, who then goes back through step 1 on the new head. Merge it with `bash scripts/merge-pr.sh <n> <branch> <that sha> "<a merged-head line for the What was run block>"`, which marks it ready and pins the merge to that sha, one at a time. Set every `idle` or `failed` agent row of the item `finished`: the engineer's with GitHub's `mergedAt` as its `finishedAt`, a failed one with a note that it failed and was replaced, keeping its real `finishedAt` if it has one. Then run the ledger check (§6): such a row would stop the check settling the item.

  A PR that can't pass these checks, such as one with a finding nobody can fix, goes to the operator under *Waiting on you*.
- **`needs-consult`**: see *Escalation*.
- **`stopped`**: a stop event, or a question for the operator. Put it to them with the engineer's evidence, and send their ruling back to the same engineer, quoting their words.
- **`failed`**: say what failed and what the branch holds. Ask the operator whether to relaunch, on the same model or one tier up.

Review rework on an open PR goes to the same engineer with `SendMessage`, so it keeps its context. "One fresh agent per ticket" means per ticket, not per round.

## 6. Keep the ledger

The ledger, its row ids and its statuses are in `docs/process.md`, *The ledger*. Write it through ArtifactData, with times from `date -u`, and put the writes of one moment in one `batch`.

Every time you write is one you read, never one you estimate or type from memory. For a merge, that is GitHub's: `gh pr view <n> --json mergedAt`, read after the merge and copied as it is, for both the item's `mergedAt` and the engineer row's `finishedAt`. For anything else, use `date -u`, read when the thing happened, or as soon as you hear of it. If you only find out later, write the time you read and say so in the `note`; don't guess an earlier one. In wave 6, hand-typed merge times left 28 mismatches for the end-of-wave check.

- **At each launch:** an `agents` row with `item`, `model`, `lane`, `status: "running"` and `startedAt`. Its kind follows the agent type: `explorer`, `builder` for an engineer, `consultant`, or `gate` for any agent that brings `main` in (§5, `ready`, step 3). Name it `<ITEM> explorer`, `<ITEM> engineer`, `<ITEM> consult <n>` or `<ITEM> merge main`. The haiku agent is a mechanical step, so it isn't chosen from the model table (§3). Its id is `<ITEM>-gate` (with `-<n>` for a second), its `lane` is the item's, its `pr` array holds the PR number, and its row becomes `finished` with `finishedAt` when it reports, whatever the outcome, or `failed` if it crashed; a consultant's `note` holds its question in a line. At an engineer's launch, also set the item's `status` to `building` and its `model`.
- **Keep each running or idle row's `step` current:** it is the stage the ledger page shows on the agent's card. Write it at launch (`Exploring`, `Building`, `Consulting`, `Merging main`). An engineer then updates its own row's `step` and `note` (`engineer.md`, *Your ledger row*): its brief gives the ledger URL and its row's doc id. Explorers and consultants have no ledger tool, so you keep theirs. Beyond the writes below, update an engineer's row yourself only if it says a ledger write was refused, then from its PR on GitHub when you check (a draft opened, ladder fix commits). Both of you pin `if_version`, and the engineer writes only `step` and `note`: on a conflict, re-read every document the refused write named and send it again, since a batch refused for one stale pin writes none of its entries. At a launch, or when you send an idle engineer work, set the row's `step` yourself (`Building`, or `Rework: <what>`), so the card never keeps a stale stage. At its report, the engineer's last `step` is `Ready: waiting to merge` for `ready`, `Waiting on the orchestrator: consult` for `needs-consult` and `Waiting on the operator: <what>` for `stopped`; for `failed` it writes none and you set the row `failed`. The stages, in the order of an item's flow, are `Exploring`, `Consulting`, `Building`, `Gating: /gate pr`, `Draft PR #<n>: merge gate` (CI, `/gate` §1–§5 and `/simplify`, before the rounds), `Merge gate: /code-review round <i> of <k>` (`<k>` is the number of rounds the PR's risk tier gets in `/gate` §6: 3 for tier 3, 1 for tier 1 or 2, and a tier 0 PR has none, so it shows no round stage; the engineer works `<k>` out from its own diff when it starts the gate), `Ready: waiting to merge`, `Rework: <what>` (a ladder fix, a conflict, a failing check), `Waiting on the orchestrator: consult` (a `needs-consult` stop), `Waiting on the operator: <what>` (a `stopped` one) and `Merging main`. The `note` says what the stage holds.
- **At each report:** an explorer's or consultant's row becomes `finished`, with `finishedAt`; a consultant's `note` gets its confidence and the answer's file. Such a gate agent's row becomes `finished` (§5, `ready`, step 3). An engineer at `ready` becomes `idle`, with its `pr`. The PR number is appended to the item's `pr` array unless it is there already, keeping any others (the board and `scripts/ledger-check.mjs` read the item's PRs, not the agent's), and the item's `status` becomes `review`. Each issue the merge gate filed gets a `followups` row, `open`, with the PR it came from in its `note` (its `pr` is for a PR that fixes it). The item stays `building` while the engineer is in the merge gate, since you hear nothing from it until it reports. One that `failed` becomes `failed`. One that ends waiting on you becomes `idle`:
  - at `needs-consult` or `stopped`, with the question or stop event in a line as its `note`.

  It goes back to `running` when you send it work with `SendMessage`. Once you've merged its PR, set it `finished` before the ledger check (§5, `ready`, step 4).
- **Consults an engineer runs itself** don't reach you until its report. Add their rows then, from the report's *Consults* line, with the times from the files under `consults/`.
- **At the end of the wave:** a `log` entry listing each item and its outcome. Then run `scripts/ledger-check.mjs` as `docs/process.md` says.

## 7. Report to the operator

End with:

```markdown
**Wave:** <items>

| Item | Model | Branch | PR | Status | Consults |
|------|-------|--------|----|--------|----------|

- **Waiting on you:** <each stop event, open question, or PR you couldn't merge, with why>
- **Not done:** <each item not merged, with the reason>
- **Bugs filed:** <each issue the merge gates filed, no advisory among them>
- **Private advisories:** <each advisory's link, with a neutral description, or "none">
```

Then ask everything in `## For the operator` through the ask tool, in one sitting (*Questions*).
