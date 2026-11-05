---
name: to-tickets
description: Break a plan, a design section, a set of scenario specs or the current conversation into tracer-bullet tickets for this repository, each with its blocking edges, a definition of done the gate can check, and links to the scenario cases it satisfies, then publish them as GitHub issues on rare-pair/app. Use when asked to turn ARCHITECTURE, FRONTEND-DISCOVERY, specs/scenarios or a discussion into tickets or issues.
argument-hint: "[spec path, scenario file, issue number, or nothing for the conversation]"
disable-model-invocation: true
---

# To tickets

Turn a plan into **tickets**: tracer-bullet vertical slices, each one PR that passes `/gate`, each naming the tickets that **block** it. They're published as GitHub issues on `rare-pair/app`, in the shape `/gate` reads (§1: definition-of-done bullets and a `Depends on:` line).

Adapted from Matt Pocock's [`to-tickets`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) skill (MIT, Copyright (c) 2026 Matt Pocock). The upstream license is in `LICENSE-upstream.md` next to this file.

## 1. Gather the source

Work from what is already in the conversation. When an argument names something, read all of it:

- A scenario file under `specs/scenarios/` (`mvp/` or `later/`): every case in it.
- A doc section: `docs/ARCHITECTURE.md` or `docs/FRONTEND-DISCOVERY.md`.
- An issue number: `gh issue view <n> --comments`.

Always read ARCHITECTURE's *Decisions so far* table. It's binding: a ticket that contradicts a row is wrong, not a scope choice. Then list open issues (`gh issue list --state open`) so you don't duplicate one; extend or depend on it instead.

## 2. Read the code that exists

See what's already built (`packages/epub`, and whichever of `apps/web`, `apps/ingest`, `apps/content`, `apps/mailer` and `packages/db` exist by now), so tickets build on it instead of re-specifying it. Use the docs' vocabulary in titles and bodies: work, version, chapter, upload, pseud, opt-out, review reason, rejection code.

Look for prefactoring that makes the slices easier ("make the change easy, then make the easy change"). It becomes the first ticket.

## 3. Draft vertical slices

Each ticket is a **tracer bullet**:

- It cuts a narrow but complete path through every layer the behaviour needs (migration in `packages/db`, ingest job, web route and page, content headers, tests), not one horizontal layer.
- When it lands, it's verifiable on its own: its scenario cases pass in workerd tests, or in a browser journey.
- It fits one fresh context window and lands as **one PR**.
- **Keep the security boundary separate.** Sanitizer, zip limits, CSP, cookies and sessions, rate limits and quotas, and the opt-out, takedown and removal paths make a PR tier 3 under `/gate` (the full review ladder). Keep each of those surfaces in its own small ticket, so a security review never has to wade through unrelated feature code. Expect most feature tickets to be tier 3 anyway: migrations, dependency or `wrangler` changes and code over 50 lines all are, and the operator ruled on 2026-10-30 that tier 3 stays the norm. Only test-only tickets usually come in at tier 2.

Give each ticket its **blocking edges**: the tickets that must merge before it can start. A ticket with none can start now.

**Wide refactors are the exception.** For one mechanical change that breaks many call sites at once (renaming a column, retyping a shared type), use **expand, migrate, contract** instead of a tracer bullet:

1. One ticket adds the new form beside the old.
2. One ticket per batch (per package or app) moves callers across; each batch is blocked by the expand and keeps the tests green.
3. A last ticket, blocked by every batch, removes the old form.

Database migrations are add-only (the gate's db protocol), so a column rename is always an expand and a contract.

## 4. Agree the breakdown with the user

Show the breakdown as a numbered list. For each ticket give:

- **Title**: short and descriptive
- **Blocked by**: the list numbers it depends on, or "none"
- **Delivers**: the end-to-end behaviour it makes work
- **Scenario cases**: the `specs/scenarios` cases it makes pass
- **Gate**: the protocols `classify.sh` will likely print, and the expected tier

Then ask:

- Is the granularity right (too coarse, too fine)?
- Does each ticket depend only on tickets that really gate it?
- Should any be merged or split?
- Is every scenario case in the source covered by exactly one ticket? List any case left uncovered, and any case the docs leave undecided, instead of inventing behaviour.

Iterate until the user approves. Publish nothing before that.

## 5. Publish as GitHub issues

Create the issues in dependency order, blockers first, so each `Depends on:` line can cite real numbers:

```bash
gh issue create --repo rare-pair/app --title "<title>" --body-file <scratchpad file> --label ready-for-agent --label mvp
```

- **Labels:** `ready-for-agent` on every ticket, unless the user says otherwise; tickets are agent-grabbable by construction. Add `mvp` or `later` to match the scenario directory. If a label doesn't exist yet, create it first (`gh label create`), and say so.
- **Sub-issues:** when the source was an existing issue, add each ticket as a sub-issue of it:
  ```bash
  gh api -X POST repos/rare-pair/app/issues/<parent>/sub_issues \
    -F sub_issue_id=$(gh api repos/rare-pair/app/issues/<ticket> --jq .id)
  ```
  The endpoint takes the issue's internal `id`, not its number. Don't close or edit the parent.
- Write each body to a file in your session scratchpad, never in the repo.
- **Report** the issue numbers in dependency order, and the **frontier**: the tickets whose blockers have all merged.

Issue body template:

```markdown
## What to build

The end-to-end behaviour this ticket makes work, from the reader's, uploader's,
author's or moderator's side. Not a layer-by-layer task list.

## Definition of done

- [ ] specs/scenarios/mvp/<file>.md: "<case title>" passes
- [ ] <any other observable result, stated so a test or live check can show it>
- [ ] `/gate` passes (protocols: <expected>; tier <n>)

## Notes

Decisions this relies on (ARCHITECTURE § …), open questions it must not
decide, and anything it deliberately leaves to a later ticket.

Parent: #<n>          (only when the source was an issue)
Depends on: #<a>, #<b>   (or "Depends on: none")
```

Keep the `Depends on:` line exactly in that form: `/gate` reads it and checks that each dependency is closed.

## Rules for every ticket

- **Cite behaviour, not code.** Reference scenario cases and doc sections, which are stable. Don't cite file paths or snippets, which go stale. The exception is a snippet a prototype or spike produced that pins down a decision better than prose (a schema, a state machine, a type): include just the decision-bearing part, and say where it came from (for example `spikes/better-auth`).
- **The repo is public.** No fic text, real AO3 epub contents or reader data in any issue. Fixtures are referred to by name only.
- **No AO3 branding.** No AO3 or OTW name, logo or styling implying affiliation, beyond provenance links and parser references.
- **Don't decide open questions.** Where the docs are silent (for example a rate-limit status code, or how pseuds are normalized), the ticket says the question is open, and either depends on a ticket that settles it or leaves it out.
