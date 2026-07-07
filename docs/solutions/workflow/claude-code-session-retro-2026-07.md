---
module: workflow
date: 2026-07-07
problem_type: best_practice
component: dev-process
tags:
  - retro
  - claude-code
  - verification
  - definition-of-done
  - ci
  - skills
  - intent-drift
root_cause: process_gap
resolution_type: workflow
related_components:
  - self-verification skill
  - ce-plan / ce-work
  - CI
---

# Claude Code session retro (2026-06-07 → 2026-07-03): where development stalled

## Source

Analysis of 9 Claude Code session transcripts for this repo. Findings ranked by
turns burned.

## Finding 1 — Unverified features are the #1 turn sink

The sponsor billboard feature shipped without anyone (human or agent) ever
seeing it render. First real local acceptance run (2026-07-03) took a **225-turn
loop** (96 bash + 15 screenshots) and surfaced 3 client bugs + 4 backend gaps
(mirrored texture, shader orientation, missing wiring). Quote from the session:
"這個看板功能其實從來沒被人真正看見過".

The `self-verification` skill already covers exactly this — but it is advisory.
Nothing forces it to run before a feature is declared done.

**Fix**: make visual verification part of definition-of-done, enforced in
CLAUDE.md, not just available as a skill. Any change with a visible effect must
present screenshot/harness evidence before commit.

## Finding 2 — Tests rot silently on main

`SceneManager.test.ts` dispose tests had been broken on main since the
targeting/sponsor/post-processing features landed (mocks never updated). The
breakage was only discovered mid-task on 2026-06-25 and cost ~35 turns to fix
before the actual work could start.

**Fix**: CI test gate. `.github/workflows/` currently only has deploy jobs; no
hook or workflow runs `pnpm -r test`. Red tests on main should be impossible to
miss.

## Finding 3 — Tooling meta-work consumed a full day

2026-06-25 (4 sessions) went almost entirely to plugin/skill housekeeping
instead of product work: ce plugin update + safety check, claude-mem stop hooks
adding ~1m39s latency per turn, and skill scaffolding that generated **17
irrelevant skills** (marketing-ideas, sound-effects, …) needing manual cleanup,
plus skills initially written to the wrong location (global instead of
project-local `.agents/skills/`).

**Fix**: when scaffolding skills, agent must present the proposed skill list for
approval before generating files, and default to `.agents/skills/` (project-
local). Batch plugin maintenance outside feature sessions. Periodically re-check
hook latency.

## Finding 4 — Intent drift caught only by the human

Two clear moments: ce-plan asked game-specific questions when the user wanted a
general BabylonJS/Rapier skill ("我以為要plan的skill是更general…"), and after a
ce-work run the user had to ask "但我原本的訴求不是要讓開發體驗變好嗎？你做了什麼？".
Both cost a correction round-trip and eroded trust in autonomous stretches.

**Fix**: before starting planned/multi-step work, restate the original goal +
success criteria in one or two lines and get confirmation. Cheap insurance
against expensive drift.

## Finding 5 — Ops incident ran blind (2026-06-07, ~5h)

Server outage → memory spike + zero swap diagnosed → SSH locked up while adding
swap → 30+ turns of blind retry loops waiting for SSH to return. No runbook, no
alerting, box not provisioned with swap. (Incident itself is documented in
`docs/solutions/infrastructure/`; D-001 records the decision.)

**Fix**: provisioning checklist (swap, memory limits, alerting) for any new box;
before risky remote ops (memory/network config), confirm an out-of-band recovery
path exists.

## Finding 6 — Research conclusions only got written down when prompted

The WebTransport-vs-WebSocket investigation spanned 3 days and a dozen Q&A
rounds; nothing was persisted until the user said "write it down". The ADR
protocol now exists in CLAUDE.md — the remaining gap is that the *agent* must
proactively trigger it at the end of any decision-shaped discussion, not wait
for the user.

## What already improved (keep doing)

The process has been self-correcting: the 06-07 incident produced the
docs/solutions protocol; the 06-25 verification pain produced the
self-verification skill + agent-eyes MCP; the 07-03 acceptance run produced
solution docs. Each pain became a durable artifact. The gap is **enforcement**:
the two changes with the highest expected turn savings are the
definition-of-done verification gate (Finding 1) and the CI test gate
(Finding 2).
