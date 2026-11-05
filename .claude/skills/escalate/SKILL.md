---
name: escalate
description: What to do on this repository when you meet a problem you can't solve with confidence. The triggers for "not confident", the ladder (advisor, then a consultant one model tier up, then the operator), and how each consultant answer is routed. Use when building, reviewing or orchestrating work here and unsure of a fix, a design choice or runtime behaviour; preloaded by the engineer agent.
---

# Escalate

When you meet a problem you can't solve with confidence, don't guess. This holds for every agent here, the orchestrator included.

## You're not confident when

- The same check fails after two different attempts at a fix.
- Code on the security boundary (`/gate` §6, the tier 3 list) has no test that shows it correct.
- A choice is hard to undo: a schema shape, a key layout in R2, a queue message format, a public URL.
- Behaviour the runtime decides isn't settled by the notes or the docs: workerd, Hyperdrive, Queues, `HTMLRewriter`.

A question the docs leave open is not a confidence problem: it's a design decision, and it goes to the operator (step 3). Models don't decide open design questions (`/to-tickets`, *Rules for every ticket*). If your definition of done can be met without the answer, don't stop for it: file the gap, leave it unbuilt, and name it in your report, and it reaches the operator at the end of the wave (`/orchestrate`, *Questions*).

## The ladder

The tiers, lowest first: `haiku` < `sonnet` < `opus` < `fable`. `fable` needs Fable access on the account; when a launch on it is refused, `opus` is the top tier.

1. **The advisor tool,** when you have one. It sees your whole transcript, so it needs no brief.
2. **A consult.** Spawn a `consultant` (`.claude/agents/consultant.md`) one tier above your own, passing the tier as the `model` parameter. Give it the question, what you tried, the options in view, and the absolute paths of the notes and files involved. Save its answer to `<scratch>/<ITEM>/consults/<n>.md` when you have a scratch root, with `n` one more than the highest file already there (whoever wrote it), and cite it in your report.
3. **The operator.** Report a stop event, in the shape of `/gate`'s *Deviations*: the question, the evidence, the options and what each would commit the project to.

## Routing the consultant's answer

| Confidence | Do |
|------------|----|
| `confident` | Act on the answer. |
| `leaning` | Act on it only once its *Check* passes. If the check fails, it's `unsure`. |
| `unsure` | Go to step 3. |
| `operator` | A design decision. Go to step 3; never act on the options yourself. |

When you're on the top tier, or the consultant can't be launched, skip to step 3.
