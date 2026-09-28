# Presentation coverage

`deft verify:presentation-coverage` (#5079) checks that a candidate under a recorded presentation ceiling has successful required checks and merge-base authority for every changed product path. The independent `verify:presentation-ceiling` supplier (#5056) owns class eligibility and boundary checks. Both belong in consumer check and CI composition. Neither composes the other.

## Shared recorded authority

The compositor reads the supplier's singular `.deft/presentation-ceiling.json` record (including nested `presentation-ceiling.json` records) and current `xbrief/{active,pending,proposed}/*.xbrief.json` records. A root `changeClass: "presentation"` takes precedence; otherwise an xBRIEF may declare `plan["x-directive/changeClass"]` or its `plan.metadata` equivalent. The xBRIEF value may be `"presentation"` or the record object. Completed history is not restriction authority.

```json
{
  "changeClass": "presentation",
  "allowedExtensions": [".html", ".jsx", ".tsx", ".css"],
  "componentRoots": ["ui/**"],
  "extensionAmendment": {
    "extensions": [".sql"],
    "humanApproval": {"kind": "human", "actor": "operator", "mintedAt": "2026-09-28T00:00:00Z"}
  }
}
```

`allowlist` is an extension-list alias, not a path glob list. Absent `allowedExtensions`/`allowlist` means the four built-in suffixes; explicit `[]` permits none of those suffixes. Simultaneous restrictions intersect built-in allowances. Human-stamped merge-base extension amendments keep extra dialects in the supplier's class independently of built-in allowlists. Coverage admission additionally requires an applicable base amendment and the current story's base path scope. Unsigned and head-only amendments do not authorize continuation. `componentRoots` constrains the relevant record's paths at both base and candidate. Removing an extension amendment or narrowing its roots at head cannot leave the former base allowance active. A stamped removal cannot mask weakening of another record. The example approval must satisfy the shared human approval stamp parser; a local JSON edit is not an approval workflow.

## Candidate and evidence

The default candidate is committed HEAD versus its computed merge base with the origin default branch. `--origin-ref <ref>` selects that origin reference, not an arbitrary authority base. `--staged` pins the whole index tree and compares it to the merge base, including earlier branch commits. Names and bytes come from that same tree; unstaged edits do not affect the result. Renames cover the old and new paths. Unmerged entries and Git enumeration/read failures return configuration error.

Restrictions at either base or candidate arm the check. Head can add/tighten restrictions, but cannot approve a weakening or removal. A removal stamped in the base record is accepted only for a restriction-only candidate. Malformed, unreadable or unsigned authority is not treated as absent.

The compositor executes the closed original seven gates: test-boundary, class-checks, scope-provenance, consumer-check-contract, evaluator-surface, observable-scope and intent-constraint. It preserves actual refusals/configuration errors and records each outcome. Required-but-unrun stays unknown. Scope provenance runs in a disposable Git checkout of the candidate, so its recovery and disk fallbacks cannot consult unstaged authority.

The adapters preserve each gate's policy source: class checks use merge-base class and boundary authority plus the candidate boundary for same-PR edit detection; test-boundary uses candidate policy. Malformed base or candidate class policy is a configuration error. Configuration failures report snapshot/gate recovery separately from an authorization refusal.

For each changed product path, continuation requires the current active story and its merge-base `file_scope`, plus one closed rule: a matching intent mint, observable mint, or applicable extension amendment. `--plan-id <id>` selects a story when more than one is active; `DEFT_ACTIVE_SCOPE` may identify its active brief. Both base and candidate contracts must match the base mint's digest. For `.ts`/`.js`, a base extension amendment is still required for class eligibility; an intent-mint admission cites both that prerequisite and the exact mint. A present mismatched contract refuses rather than falling back to an amendment. Historical unrelated records do not grant authority. A scanner's analyzed path is insufficient when it refused, skipped, or reported non-adoption. CSS without applicable base authority and production source outside the recorded class refuse. The #4541 intent fact/language boundary remains unchanged.

## Output and check modes

Exit codes are `0` (off-ceiling or authorized continuation), `1` (refusal), and `2` (configuration/unknown execution). `--json` emits typed coverage rows, uncovered paths, and admissions naming each path, rule and exact base record. `--quiet` suppresses prose. Off-ceiling candidates keep independent gates' existing behavior.

Rapid mode retains both presentation gates; coverage runs its seven evaluators itself. Pressure mode cannot downgrade an armed required failure, including one observed before the compositor. The check aggregate consumes the typed JSON report and rejects missing or inconsistent results. Consumer composition omitting coverage is an enforcement-contract violation.

Root comparison proves containment for literal roots and recursive literal subtrees (`db/**` to `db/narrow/**`). Bare `db` also includes the exact path `db`; changing `db/**` to bare `db` therefore widens authority. Other glob relationships remain unproved unless identical and are refused conservatively.

The check adapter accepts one terminal single-line JSON report after non-JSON build diagnostics, because a cold Task invocation may build the CLI first. Duplicate reports, JSON-like prefixes, trailing diagnostics, invalid report rows, and a report/process exit mismatch remain configuration errors.
