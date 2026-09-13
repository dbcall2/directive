# Observable UI scope (`verify:observable-scope`)

Refs: #4495 · Related: [scope-provenance.md](./scope-provenance.md) (#3145), [gate-integrity.md](./gate-integrity.md) (#3156)

First ship is **not** universal UI coverage. Applicability is opt-in and base-pinned.

## Contract

1. Commit `.deft/observable-ui.policy.json` on the merge base listing UI path globs (`schema: deft.observable-ui.policy.v1`). Outside those globs the check is N/A (internal skip). Inside, an absent mint record fails.
2. Put the story contract on `plan["x-directive/observableChange"]` (not bare `plan.observableChange`).
3. Mint with `task scope:record-observable-scope -- <xbrief> --actor <you> --confirm` (#3110). Commit `.deft/observable-scope/<plan-id>.json` on the merge base **before** the UI-change PR. Same-PR rewrite fails. `--actor` is display-only.
4. `task verify:observable-scope` computes the merge base (no worker-declared `baselineRef`) and compares a versioned committed-markup oracle (`deft.observable-ui.v1` / provider `committed-markup`) for tabs, headings, controls, table columns, landmarks, and major containers as encoded in source. Runtime default-tab JS state is out of scope unless markup-visible (`selected` / `aria-selected`).

One remediation: restore the baseline markup structure or amend the observable scope through explicit human-presence mint (`scope:record-observable-scope`).

The verb is composed on `task check` with an internal skip when the surfaces policy is unset, so non-UI consumers stay green. It is not a required-enforcement gate.

Three-state exit: `0` skip or pass / `1` missing mint or unlisted delta / `2` invalid configuration.
