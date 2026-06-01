# #1387 — Headless / low-ceremony swarm launch for pre-approved cohorts

> Archive copy of Warp plan `c3382a48-a555-48e2-bc6b-aa465dcdc835` (created 2026-06-01). Per Warp Drive rule: implementation plans are archived under `history/` alongside the live Warp plan.

Decomposition pass output for issue #1387 (OPEN; `documentation, enhancement, swarm, agent-experience`). Builds on the merged #1378 allocation-context token + Gate 0. The deft decomposition draft validates clean (`task scope:decompose --check` → `VALIDATED 3 story decomposition draft`, exit 0).

## Problem
The swarm skill (`skills/deft-directive-swarm/SKILL.md`) is a long, phase-driven workflow with multiple approval gates (Phase 0 promote-fill loop, Step 0.5 bridge, Phase 1 overlap audit, Phase 3 launch). For the common "I have N ready stories, just launch them" case (deftvisage experience report on #1387), it is too heavyweight, so consumers fall back to manual worktree creation + raw `spawn_subagent`, losing the blessed monitoring, conflict-group handling, and review-cycle tooling.

## Key design decision — dispatch boundary
- **Deterministic prep CLI** (`task swarm:launch`): story resolution, gate enforcement (#810 preflight + `swarm:readiness`), worktree mapping, dispatch-envelope generation with the #1378 token, and launch-manifest emission.
- **Agent-driven spawn** stays in the swarm skill Phase 3 Step 2a/2d (`start_agent` / `spawn_subagent`) — a Python script cannot call the orchestration primitives, so the actual spawn remains the monitor's job.

## Frozen contracts (enable parallel build)
Encoded in the parent epic `vbrief/proposed/2026-06-01-1387-headless-swarm-launch.vbrief.json`:
- **C1 — `task swarm:launch` signature**: `--stories <ids|paths> [--group <label>] [--worktree-map <path>] [--base-branch <branch>] [--autonomous]`.
- **C2 — launch-manifest JSON**: array of `{ story_id, vbrief_path, worktree_path, branch, allocation_context }` where `allocation_context` is the populated #1378 token.
- **C3 — worktree-map JSON**: array of `{ story_id, worktree_path, base_branch }`; missing worktrees created idempotently, collisions/base mismatches rejected.

## Proposed changes — 3 swarm-ready stories
All `readiness: ready`, `parallel_safe: true`, `size: medium`, `file_scope_confidence: high`, `depends_on: []`, disjoint `file_scope`. Draft: `vbrief/.eval/decompositions/1387-headless-swarm-launch.json`.

1. **`swarm-launch-cli`** — owns `scripts/swarm_launch.py`, `tasks/swarm.yml`, `tests/cli/test_swarm_launch.py`. The deterministic prep engine + `swarm:launch` task target.
2. **`swarm-worktree-map`** — owns `scripts/swarm_worktrees.py`, `tests/cli/test_swarm_worktrees.py`. Pre-created worktree validation + idempotent creation + normalized C3 output.
3. **`swarm-skill-headless-prose`** — owns `skills/deft-directive-swarm/SKILL.md`, `AGENTS.md`, `tests/content/test_swarm_headless_launch.py`. Phase 0/2/3 headless prose + AGENTS.md mirror + content test. Sole owner of the shared skill file (dogfooding caveat).

## Orchestration
3 local child agents, one per story, isolated worktrees `../wt-1387a|b|c` on branches `agent1/feat/1387-swarm-launch-cli`, `agent2/feat/1387-swarm-worktree-map`, `agent3/docs/1387-headless-prose`. Frozen contracts → parallel build → lead integrates engine ← resolver, then skill prose. CHANGELOG `[Unreleased]` is the only shared-file touch (append-only union-merge). Three PRs cascade-merged via `task pr:wait-mergeable-and-merge`.

## Validation
- `task scope:decompose --check` → clean (done).
- After apply: `task swarm:readiness -- vbrief/pending/<3 children>` (all ready, zero overlap) before activation.
- Per story `verify_commands`; then `task check` on the integration head.

## Status
Decomposition validated and presented; **not applied** (no child vBRIEFs written, nothing committed) pending user approval per decompose skill Phase 2.
