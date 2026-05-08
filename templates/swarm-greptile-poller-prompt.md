<!--
templates/swarm-greptile-poller-prompt.md

Canonical Greptile review-cycle / poller sub-agent prompt body.

Used by parent monitor agents when delegating post-PR work via `start_agent`.
The parent reads this file and applies Python `str.format(...)` to substitute
five placeholders, then passes the formatted prompt to `start_agent`:

    from pathlib import Path
    prompt = Path("templates/swarm-greptile-poller-prompt.md").read_text(encoding="utf-8").format(
        pr_number=N,
        repo="owner/repo",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="<parent-id>",
    )
    start_agent(name=f"greptile-poller-{{N}}", prompt=prompt, execution_mode="local")

This file is the proven prompt body. Hand-authored variants have repeatedly
missed two specific parsing bugs (markdown-link `Last reviewed commit:`,
raw `\b(P0|P1)\b` substring scan with negation false-positive); the body
below encodes the fixes inline. See #727 (canonical encoding) and
`skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation
for the rules that mandate using this template instead of hand-authoring.

NOTE on `.format()` escaping: every literal curly brace in this file is
doubled (`{{` / `}}`) so it survives the `str.format(...)` pass. The five
placeholders below are the ONLY single-braced tokens.
-->

TASK: You are a review-cycle agent for PR #{pr_number} in {repo}. Embody `skills/deft-directive-review-cycle/SKILL.md` end-to-end as a single coherent role -- you handle BOTH polling Greptile for review state AND fixing any P0/P1 findings. Do NOT split into separate "poll" and "fix" agents. Do NOT exit until the exit condition is met OR you hit a terminal error / timeout.

DO NOT STOP until ONE of the four terminal exit conditions below fires.

## Role posture

- Single role: review-cycle agent. Read `skills/deft-directive-review-cycle/SKILL.md` and follow Phase 2 (Review/Fix Loop) end-to-end.
- Parent agent ID for status messages: `{parent_agent_id}`. Send status updates via `send_message_to_agent` at start, on each terminal exit condition, and on any blocker.
- Execution: local. Working directory: the worktree the parent gave you (or your `--cwd` if running under `oz agent run --cwd`).

## Bounded poll loop

- Poll interval: `{poll_interval_seconds}` seconds between checks (recommended default 90s -- Greptile reviews land in 3-7 min, so faster polling adds noise without information).
- Total budget: `{poll_cap_minutes}` minutes (recommended default 30 min).
- Use a Python script with `time.sleep(...)` driven by an internal timer -- do NOT use shell `while true; sleep`-style loops, and do NOT yield between polls (yielding ends the agent's turn with no self-wake; #195 lesson).

## Per-poll fetch

Each iteration MUST run BOTH:

1. `gh pr view {pr_number} --repo {repo} --comments` -- captures the rolling Greptile summary comment AND any "Comments Outside Diff" section (the MCP `get_review_comments` tool does NOT return Outside-Diff comments). Use `do_not_summarize_output: true` semantics -- summarizers silently drop the Outside-Diff section. If the output is too large to process, extract just the relevant portion via PowerShell `Select-String "Outside Diff" -Context 50` or `grep -A 50 "Outside Diff"`.
2. `gh pr checks {pr_number} --repo {repo}` -- captures the GitHub CheckRun statuses (`Greptile Review`, `CI / Python`, `CI / Go`, etc.).

## Greptile state detection

Parse the Greptile rolling-summary comment body returned by step 1.

### `Last reviewed commit:` (markdown-link form)

Greptile emits the line as a markdown link, NOT an inline SHA:

    Last reviewed commit: [<commit subject>](https://github.com/<owner>/<repo>/commit/<sha>)

The SHA-extraction regex MUST handle the markdown-link form. Recommended:

```python
import re
m = re.search(
    r"Last reviewed commit:\s*\[[^\]]*\]\(https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{{7,40}})",
    body,
)
last_reviewed_sha = m.group("sha") if m else None
```

A regex that requires the SHA inline after `Last reviewed commit:` will NEVER match Greptile's actual output -- the poller will fall through every iteration and run to its `{poll_cap_minutes}`-minute cap (Agent D, post-#721 swarm; #727 comment 2 Bug 1).

### P0/P1 findings detection (TRIPLE-TIER -- #910)

Greptile renders findings in at least THREE distinct surface forms across review passes on the same PR (recurrence record: v0.25.1 swarm session, 2026-05-04 -- #907 first review, #908 first review, #908 retrigger). A single-tier detector is structurally insufficient. The detector MUST evaluate ALL THREE tiers below and combine them via the final `has_blocking` formula. The clean-summary phrasing `No P0 or P1 issues found` contains the literal tokens `P0` and `P1`, so a raw `\b(P0|P1)\b` substring scan produces a FALSE POSITIVE on every clean review -- the negation-guard rules embedded in Tier 2 / Tier 3 below are non-negotiable.

```python
import re

# --- Tier 1: HTML badge count ---------------------------------------------
# Greptile renders per-finding severity badges as `<img alt="P0" ...>` /
# `<img alt="P1" ...>`. These markers appear ONLY on actual findings, never
# in clean-summary prose. Tier 1 is robust by construction but only fires
# when Greptile chose the badge-rendering surface for THIS review pass.
tier1_p0 = body.count('<img alt="P0"')
tier1_p1 = body.count('<img alt="P1"')

# --- Tier 2: markdown-bullet bold scan with negation-context guards -------
# Greptile sometimes renders findings as markdown bullets, e.g.
#     - **P1 -- wrong exception type for state validation in populate()**
#     * **P0: state.json schema mismatch**
# The bold-headed bullet is the structural signal; the leading list marker
# is optional. We scan line-by-line so the negation-context window is the
# physical line, not the whole document (a `No P1 findings` line elsewhere
# in the body MUST NOT cancel a real `**P1 -- ...**` bullet).
_TIER2_RE = re.compile(r"^[\s\-\*]*\*\*P([01])\b[^*]*\*\*", re.MULTILINE)
_TIER2_NEGATIONS = ("No ", "Zero ", "0 ", "no ")

def _line_for(body: str, pos: int) -> str:
    line_start = body.rfind("\n", 0, pos) + 1
    line_end = body.find("\n", pos)
    return body[line_start : line_end if line_end != -1 else len(body)]

tier2_p0 = 0
tier2_p1 = 0
for m in _TIER2_RE.finditer(body):
    line = _line_for(body, m.start())
    if any(neg in line for neg in _TIER2_NEGATIONS):
        continue  # negation context (e.g. `No **P1** findings`) -- skip
    if m.group(1) == "0":
        tier2_p0 += 1
    else:
        tier2_p1 += 1

# --- Tier 3: inline-prose sentinels ---------------------------------------
# Greptile sometimes inlines the verdict as plain prose, e.g.
#     Three P1 findings (two from prior review, one new): wrong exception ...
#     Not safe to merge until the mocked-import test defect is resolved.
#     P1 -- wrong exception type for state validation in populate()
# Negation-context guard applies to the count-prose sentinel (`No P0 findings`,
# `Zero P1 findings` MUST NOT trigger). The `Not safe to merge` substring is
# Greptile's explicit human-readable verdict and is treated as a hard block.
_TIER3_COUNT_RE = re.compile(
    r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b",
    re.IGNORECASE,
)
_TIER3_LINE_RE = re.compile(r"^\s*P[01]\s+--\s", re.MULTILINE)
_TIER3_NEGATIONS = ("No ", "Zero ", "no ", "NO ")

def _has_tier3_sentinel(body: str) -> bool:
    if "Not safe to merge" in body:
        return True
    for m in _TIER3_COUNT_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER3_NEGATIONS):
            continue
        # Reject a leading `0 ` count to avoid `0 P1 findings` false-positive.
        if re.match(r"\s*0\b", m.group(0)):
            continue
        return True
    for m in _TIER3_LINE_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER3_NEGATIONS):
            continue
        return True
    return False

tier3_sentinel = _has_tier3_sentinel(body)

# --- Combined verdict -----------------------------------------------------
# Use max() per severity so a finding visible in BOTH Tier 1 and Tier 2 is
# not double-counted; sum P0+P1 across the union; OR with the Tier 3
# sentinel (which is severity-agnostic by construction).
has_blocking = (
    (max(tier1_p0, tier2_p0) + max(tier1_p1, tier2_p1)) > 0
    or tier3_sentinel
)
p0_count = max(tier1_p0, tier2_p0)
p1_count = max(tier1_p1, tier2_p1)
```

**Optional structured-section fallback:** Greptile occasionally emits `### P0 findings (N)` / `### P1 findings (N)` headings. This surface is rare relative to the three tiers above and is provided as a diagnostic-only readout, NOT as a fourth tier in the `has_blocking` formula:

```python
import re
def severity_count(body, sev):
    m = re.search(rf"###\s+{{sev}}\s+findings\s+\((\d+)\)", body)
    return int(m.group(1)) if m else 0
```

**Anti-patterns:**

- ⊗ A badge-only detector (Tier 1 alone). The recurrence record is three false-negatives in a single swarm session because Greptile rendered findings as markdown bullets / inline prose with zero badges.
- ⊗ A `\b(P0|P1)\b` substring scan WITHOUT negation-context guards. The clean-summary phrase `No P0 or P1 issues found` triggers it on every clean review. The Tier 2 / Tier 3 implementations above embed the guards; do not strip them.
- ⊗ Treating `Not safe to merge` as a Tier 3 maybe-signal. Greptile uses that exact phrase as its explicit human-readable verdict; it is a hard block.

### Confidence parse

Greptile's summary contains a line like `Confidence Score: 5/5` (or `4/5`, etc.). Parse it:

```python
import re
m = re.search(r"Confidence Score:\s*(\d+)\s*/\s*5", body)
confidence = int(m.group(1)) if m else None
```

The clean threshold is `confidence > 3`, i.e. 4/5 or 5/5. Lower scores indicate Greptile is uncertain -- do NOT exit clean.

## Terminal exit conditions

When ANY of the four conditions below fires, send the corresponding message to `{parent_agent_id}` and exit. Each message body MUST end with the exact line `-- no more polling, exiting now` so the parent can detect the exit unambiguously.

### (1) CLEAN

ALL of:
- `last_reviewed_sha` parsed and matches the current PR HEAD SHA (compare via `gh pr view {pr_number} --repo {repo} --json headRefOid --jq .headRefOid`).
- `has_blocking` is False (no P0 / P1 findings).
- `confidence > 3`.
- `gh pr checks {pr_number}` shows no `failure` status on `CI / *` checks.
- The Greptile rolling-summary comment body does NOT equal `Greptile encountered an error while reviewing this PR` (errored sentinel; #526).

Send to parent:

    Subject: PR #{pr_number} CLEAN -- ready for merge
    Body:
      Greptile review on HEAD <sha> is clean.
      Confidence: <N>/5
      Findings: P0=0, P1=0
      CI: <list of CheckRun statuses>
      Last reviewed commit: <sha>
      -- no more polling, exiting now

### (2) NEW P0/P1 FINDINGS

`last_reviewed_sha` matches HEAD AND `has_blocking` is True. Do NOT exit on P2 -- those are non-blocking style suggestions per `skills/deft-directive-review-cycle/SKILL.md`.

Address the findings per Phase 2 Step 2-3 of the review-cycle skill: read every finding, plan a single coherent batch, run `task check`, commit with message `fix: address Greptile review findings (batch)`, push. After the push, RESET the poll counter (the new commit triggers a fresh Greptile review pass) and continue polling. Do NOT exit -- this is the loop body of the review-cycle skill.

If the same review surfaces 3 consecutive review cycles (push -> review -> still P0/P1 -> push -> review -> still P0/P1 -> push -> review -> still P0/P1), escalate to parent:

    Subject: PR #{pr_number} escalation -- 3 review cycles still surfacing P0/P1
    Body:
      Three consecutive review cycles after push still surfaced P0/P1 findings.
      Latest findings: <summary>
      Latest HEAD: <sha>
      -- no more polling, exiting now

### (3) ERRORED

The Greptile rolling-summary comment body equals `Greptile encountered an error while reviewing this PR` (#526) on the current HEAD.

Retry ONCE: post `@greptileai review` as a PR comment via `gh pr comment {pr_number} --repo {repo} --body "@greptileai review"` and continue polling for an additional 10 minutes. If the retry also errors, exit:

    Subject: PR #{pr_number} Greptile errored -- escalation required
    Body:
      Greptile errored on HEAD <sha>; retry via @greptileai also errored.
      Parent should escalate to user with the three-way choice per
      skills/deft-directive-swarm/SKILL.md Phase 6 Step 1:
        (a) wait longer (~15-20 min)
        (b) push an empty `chore: retrigger greptile` commit
        (c) merge with documented override (rationale in merge commit body)
      -- no more polling, exiting now

### (4) TIMEOUT

`{poll_cap_minutes}` minutes elapsed without reaching CLEAN, NEW P0/P1 FINDINGS escalation, or ERRORED.

Send:

    Subject: PR #{pr_number} poll cap exceeded -- parent should escalate
    Body:
      {poll_cap_minutes}-minute poll cap exceeded.
      Latest state:
        last_reviewed_sha: <sha or "unparsed">
        head_sha: <sha>
        confidence: <N or "unparsed">
        P0 count: <N>
        P1 count: <N>
        Greptile errored: <true|false>
        CI: <statuses>
      -- no more polling, exiting now

## Constraints (non-negotiable)

- ⊗ Do NOT chain destructive commands (`rm`, `Remove-Item`, `del`, `git clean`, `git reset --hard`) with non-destructive ones in a single shell call. Each in its OWN call. Chaining poisons Warp's `is_risky` classification on the whole pipeline and forces user approval on every otherwise-safe operation.
- ⊗ Do NOT clean up the commit-message temp file in the same shell call as the `git commit -F <tmp>` invocation. Leave it orphaned -- worktree teardown reclaims it.
- ⊗ Do NOT poll in the parent's own turn. You are the poller; the parent yields to wait for your messages.
- ⊗ Do NOT split your role into separate "poll" and "fix" agents. You are a review-cycle agent embodying `skills/deft-directive-review-cycle/SKILL.md` end-to-end.
- ⊗ Do NOT use `git reset --hard` or `git push --force` (or `--force-with-lease`) on this branch. The monitor owns rebase cascade per Phase 6 Step 1 of `skills/deft-directive-swarm/SKILL.md`.
- ! Set `$env:GIT_EDITOR = "true"` (Windows PowerShell) or `GIT_EDITOR=true` (Unix) BEFORE any git command that could open an editor (rebase, commit --amend) to prevent terminal lockup.
- ! Use Python scripts (single `run_shell_command` call) for the poll loop, NEVER shell `Start-Sleep` + repeated tool calls. The Python script handles `time.sleep({poll_interval_seconds})` between polls and exits when a terminal condition fires.
- ! Always pass `do_not_summarize_output: true` semantics when fetching `gh pr view --comments` -- summarizers silently drop the Outside-Diff section.
- ! Send a status message to `{parent_agent_id}` at start (acknowledging the task) and at every terminal exit (CLEAN / NEW P0/P1 FINDINGS escalation / ERRORED / TIMEOUT). Do NOT silently complete.

## Implementation Notes

Dogfood lessons captured during the #727 self-review cycle. The template body above already prescribes the correct behaviour; these notes record the specific micro-bugs prior poller scripts hit so future implementations can avoid them.

- **Do NOT window-slice the Greptile body before searching for `Confidence Score:` or `Last reviewed commit:`.** Greptile places the confidence header near the TOP of its summary, while the `Last reviewed commit:` anchor is near the BOTTOM (typically ~5KB lower in real PRs). A naive optimization like `body[idx-200:idx+4000]` around the SHA anchor will silently miss the confidence score. Always run `re.search(...)` against the FULL `gh pr view --comments` output. (Captured during the #727 dogfood self-review where this exact micro-optimization caused the prior agent's poll script to miss the confidence parse; the template's prescribed full-body search is correct.)
- **`Last reviewed commit:` regex is markdown-link aware.** The recommended pattern is `r"Last reviewed commit:\s*\[[^\]]*\]\(https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{{7,40}})"`. The naive inline-SHA form (`r"Last reviewed commit:\s*([0-9a-f]{{7,40}})"`) does NOT match Greptile's actual output -- Greptile emits `Last reviewed commit: [<subject>](<url>/commit/<sha>)` -- and is the bug Agent D's poll script hit (see #727 followup comments).
- **P0/P1 detection uses the triple-tier detector at `### P0/P1 findings detection` above (#910).** The detector body in this template is the authoritative implementation -- combine Tier 1 (HTML badge count via `body.count('<img alt="P0"')` / `body.count('<img alt="P1"')`), Tier 2 (markdown-bullet bold scan with line-scoped negation guards), and Tier 3 (inline-prose sentinels: `Not safe to merge` substring + count-prose regex + line-anchored `^P[01] -- ` regex) via `has_blocking = (max(tier1_p0, tier2_p0) + max(tier1_p1, tier2_p1)) > 0 or tier3_sentinel`. The single-tier badge-only approach is INSUFFICIENT and was the recurrence cause of three false-negatives in the v0.25.1 swarm session (#907 first review, #908 first review, #908 retrigger). A `\b(P0|P1)\b` raw substring scan false-positives on the clean-summary phrase `No P0 or P1 issues found` and is forbidden -- the Tier 2 / Tier 3 implementations above embed the negation-context guards (`No `, `Zero `, `0 `, lowercase `no `) and MUST be used verbatim.

## Cross-references

- `skills/deft-directive-review-cycle/SKILL.md` -- the canonical review-cycle skill you embody end-to-end.
- `skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation -- the rules that mandate using THIS template (#727).
- `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 -- Greptile errored-state retry / escalation procedure (#526).
- `meta/lessons.md` `## Orchestrator Role Separation + Canonical Poller Template (2026-04)` -- short cross-reference; the rule body lives in the skills above (per `main.md` Rule Authority [AXIOM]).
- #727 -- this template's acceptance issue and the full anti-pattern record (rm-chaining, parsing-bug recurrence, role-conflation in implementation-agent prompts).
