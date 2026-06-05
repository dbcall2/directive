# Swarm-fix 4 issues: #1001, #1002, #1003, #1027

> Archive copy of the Warp plan (plan_id `cc3bb918-1801-4f22-8817-e70dd081a5ae`), created 2026-06-05. Source of truth is the Warp plan; this is the history archive per project convention.

Implement four open `deftai/directive` issues in parallel via local worktree agents, run each through its Greptile review cycle, then merge all four (merges pre-approved by operator).

## Problem
Four open issues were selected from the triage queue and confirmed by a body-level review. They are independent bug/enhancement fixes touching disjoint surfaces, making them ideal for a parallel swarm:
- **#1001 (HIGH)** `release:publish` REST `/releases/tags/{tag}` 404s on draft releases (post-#961 regression). Blocks the canonical Phase-6 publish path.
- **#1002 (HIGH)** cp1252 `UnicodeDecodeError` in `triage_bootstrap` subprocess on Windows (#798/#1366 chain). Currently a non-failing thread warning, but real on the maintainer's Windows env.
- **#1003 (MEDIUM)** `resolve_changelog_unreleased` dedup gap on truncated/issue-numberless entries (#911 follow-up). Recurring CHANGELOG corruption on swarm cascades.
- **#1027 (MEDIUM)** Coverage 85% blind spot for headless pygame/tkinter (Desktop/TUI `project_type`): silent agent false-pass then full-suite failure.

## Current state
All four are untriaged with no vBRIEF coverage. Working tree clean on `master`; cache fresh; `wipCap=15` (current WIP 0). Branch policy `allowDirectCommitsToMaster=true`.
File surfaces are disjoint except `CHANGELOG.md` (shared, append-only).

## Proposed pipeline
1. **Ingest** each issue to a scope vBRIEF: `task issue:ingest -- <N>` (lands in `vbrief/proposed/`).
2. **Activate**: `task scope:promote -- <path>` then `task scope:activate -- <path>` (→ `vbrief/active/`, `plan.status=running`); `task vbrief:preflight -- <path>` (#810 gate).
3. **Readiness + overlap audit**: `task swarm:readiness -- vbrief/active/*.vbrief.json`.
4. **Dispatch** 4 local child agents (one per issue), each in its own worktree/branch, running STEP 1-6 swarm prompt.
5. **Monitor** via lifecycle events + agent messages.
6. **Cohort gate**: `task swarm:verify-review-clean -- <prs>` must exit 0.
7. **Merge cascade** (monitor-owned): rebase onto latest `master`, then per-PR atomic `task pr:merge-ready -- <N> && gh pr merge <N> --squash --delete-branch --admin`. CHANGELOG conflicts via `task changelog:resolve-unreleased`.
8. **Close-out**: `task swarm:complete-cohort -- --cohort 'vbrief/active/*.vbrief.json'`, then `task vbrief:validate`; verify issues closed; remove worktrees/branches.

## Per-issue fix scope and file ownership
- **#1001** → `scripts/release_publish.py`, `scripts/gh_rest.py` (docstring), `tests/cli/test_release_publish.py`. Fix: resolve draft releases by release ID, `PATCH /releases/{id}` draft=false; regression test.
- **#1002** → `scripts/triage_bootstrap.py`, `scripts/_triage_bootstrap_*.py`, `tests/test_triage_bootstrap.py`, `meta/lessons.md`. Fix: route subprocess captures through `_safe_subprocess.run_text` / add `encoding="utf-8", errors="replace"`; regression test.
- **#1003** → `scripts/resolve_changelog_unreleased.py`, `tests/cli/test_resolve_changelog_unreleased.py`. Fix: don't dedup malformed against valid + content-prefix fallback; synthetic cascade test.
- **#1027** → `skills/deft-directive-setup/**`, `languages/python.md`. Fix: scaffold coverage-omit + documented headless `SDL_VIDEODRIVER=dummy` pattern.
Shared (append-only): `CHANGELOG.md`.

## Orchestration
- **Decision**: 4 parallel local child agents (one per issue); disjoint files, ~4x wall-clock reduction.
- **Launch**: single `run_agents` batch of 4, local, inherit run-wide settings from orchestration config; each child creates its own worktree.
- **Child agents**:
  - `agent-1001` → worktree `C:\Repos\deft\deft-agent-1001`, branch `agent1/fix/1001-release-publish-draft-404`.
  - `agent-1002` → worktree `C:\Repos\deft\deft-agent-1002`, branch `agent2/fix/1002-cp1252-subprocess-decode`.
  - `agent-1003` → worktree `C:\Repos\deft\deft-agent-1003`, branch `agent3/fix/1003-changelog-dedup-gap`.
  - `agent-1027` → worktree `C:\Repos\deft\deft-agent-1027`, branch `agent4/fix/1027-coverage-headless-gui`.
- **Merge strategy**: four separate PRs; monitor rebases + merges in `#1001 → #1002 → #1003 → #1027` order; CHANGELOG conflicts via `task changelog:resolve-unreleased`.

## Version / release
3 fixes + 1 enhancement → patch bump. Only `[Unreleased]` CHANGELOG entries accumulate; actual release deferred to `deft-directive-release` unless requested.

## Risks
- CHANGELOG cascade conflicts (expected) → `task changelog:resolve-unreleased`.
- #1002 is currently a warning, not a hard failure → verify the regression test reproduces the decode path.
- Greptile re-review latency (~2-5 min per rebase force-push).
- Autonomous merges pre-approved, but objective gates (review-clean, P0/P1, `task check`) still hold.
