# Codebase MAP Source of Truth

Status: accepted for #1595 PR 1; MAP projection implemented through #1595 PR 4; consumer guidance propagated in #1595 PR 6; MAP series complete as scoped

Date: 2026-06-12

Related: [#958](https://github.com/deftai/directive/issues/958), [#1492](https://github.com/deftai/directive/issues/1492), [#1498](https://github.com/deftai/directive/issues/1498), [#1595](https://github.com/deftai/directive/issues/1595), [#1618](https://github.com/deftai/directive/issues/1618), [#1379](https://github.com/deftai/directive/issues/1379)

## Decision

Directive will preserve the orientation goal from #958, but will not implement
hand-authored source file headers as the authoritative store for codebase
structure.

The durable source of truth for module ownership, path ownership, allowed
patterns, and projection outputs belongs in vBRIEF-owned architecture metadata.
The first implementation tracker for that path was #1595; PR 1, PR 2, PR 3,
PR 4, and PR 6 complete the MAP series as scoped.

The primary projection is a generated codebase MAP. Optional source file headers
may be added later only as generated projections from the same metadata, not as
metadata that agents edit by hand or treat as authoritative.

## Current Implementation Status

Shipped:

- Authored `plan.architecture.codeStructure` metadata in
  `vbrief/PROJECT-DEFINITION.vbrief.json`.
- Local schema typing for `codeStructure`.
- `task codebase:validate-structure`.
- Dependency-free default extractor and `codebase-map.v1` artifact shape.
- Provider artifact contract and local schema-subset validation.
- Projection-kind registry for `codebase-map`.
- Generated `.planning/codebase/MAP.md`.
- Freshness checks for that generated MAP.
- Consumer-facing guidance in AGENTS.md, the installed AGENTS template, and
  build/sync/pre-pr skills.

Split follow-up / not in the completed MAP series:

- Generated source headers.

This means the source-of-truth decision, pre-MAP contract layer, generated MAP
output, freshness gate, and consumer guidance have landed. Generated headers
remain a split optional projection follow-up. Local indexes/materialized views
are tracked separately by #1618.

## Superseded Direction

#958 proposed three useful agent-orientation ideas:

- structured file headers
- a generated codebase MAP
- glossary-aware comments and term pointers

The reframed direction keeps the MAP and the orientation benefit, but changes
the authority boundary:

- hand-authored headers are not the implementation plan
- source files are not the durable registry for module metadata
- glossary and comment semantics remain owned by the glossary path
- the MAP is generated from canonical metadata plus code-derived facts

This makes #958 superseded as an implementation plan while preserving its user
value.

## Source of Truth Contract

`codeStructure` metadata is the durable record. It should describe the intended
codebase shape at a level useful to agents and maintainers:

- `modules[]` with stable ids, names, purposes, path globs, and optional owners
- `pathOwnership[]` for ownership cases that module globs cannot express cleanly
- `allowedPatterns[]` for module-scoped implementation patterns or constraints
- `projectionManifest[]` for generated outputs such as a codebase MAP
- optional `filePurposeOverrides[]` where generated inference needs a human
  override
- optional `glossaryRefs[]` that point to existing glossary terms without moving
  glossary ownership into this feature

Future validators and writers must preserve unknown architecture keys so the
metadata can evolve without breaking existing projects.

## Metadata Home

Canonical home, aligned with the #1595 current-shape override:

```json
{
  "plan": {
    "architecture": {
      "codeStructure": {}
    }
  }
}
```

Directive types this surface locally in `vbrief/schemas/vbrief-core.schema.json`
while coordinating the upstream `deftai/vBRIEF` landing as a follow-up.

If a consumer cannot type `plan.architecture` yet, the consumer extension
namespace remains a fallback:

```json
{
  "x-directive/architecture": {
    "codeStructure": {}
  }
}
```

The extension namespace is a fallback, not Directive's dogfood home.
No standalone canonical `codeStructure` file is allowed. Standalone paths are
allowed only for generated projections that are banner-marked, declared in
`projectionManifest[]`, and drift-checked or gitignored.

`codeStructure` also scales with codebase size, not work-item count:
`modules[]` / `pathOwnership[]` grow with module count and `filePurposeOverrides[]`
is potentially O(files). Keep it to human *overrides* of inferred purpose — never
a full per-file registry — so the authored surface stays small in large
monorepos.

## Projection Contract

Generated artifacts must point back to the metadata that produced them.
Projection drift checks compare projections to vBRIEF-owned metadata and
code-derived facts. They must not compare vBRIEF back to generated prose or
source comments.

The MAP projection should be the first deliverable because it gives agents the
orientation benefit without writing metadata into source files.

Optional headers, if they remain useful after the MAP exists, must follow these
constraints:

- opt-in configuration
- generated banner and source-of-truth pointer
- check and apply modes
- no hand-authored header authority
- no default hard failure in `task check` until Directive has dogfooded the
  projection and the freshness signal is reliable

## Rollout Sequence

1. Record this decision and #958 disposition.
2. Define and validate the first concrete `codeStructure` shape.
3. Add a deterministic dependency-free default extractor, provider interface,
   and discipline gate.
4. Generate the codebase MAP from metadata plus provider-derived facts, with a
   freshness check.
5. Split optional generated headers into a separate follow-up after the MAP
   machinery exists.
6. Update skills, docs, and consumer-facing guidance after a dogfood window.

Steps 1-4 are complete in the current repository. PR 6 completes the
skills/docs/consumer-guidance part of step 6, so the #1595 MAP series is
complete as scoped. Step 5 remains split optional follow-up work; PR 5 was not
issued because the generated-header projection was deferred rather than used to
block PR 6 guidance propagation.

## Non-Goals

- mandatory hand-authored file headers
- a default `task check` failure for missing headers
- a glossary or comment-semantics redesign
- full source-code generation from vBRIEF metadata
- AST support for every language in the first implementation slice

## PR 3 Contract Layer

PR 2 defined and dogfooded the first concrete `codeStructure` profile at
`PROJECT-DEFINITION.plan.architecture.codeStructure`.

PR 3 adds the contract layer needed before MAP rendering: a deterministic
dependency-free default extractor, a provider artifact handshake, a
projection-kind registry, and stricter discipline checks that keep derived facts
out of authored metadata. The provider artifact contract is published as the
language-neutral JSON Schema `vbrief/schemas/codebase-map.schema.json`. That
schema is the normative contract, and `scripts/codebase_provider.py` validates
provider artifacts by interpreting the schema with a dependency-free local
subset validator rather than maintaining a second hand-written Python contract.
`tests/fixtures/codebase-map.v1.golden.json` is the canonical example output
and regression anchor, so out-of-process providers do not have to
reverse-engineer the Python extractor. This keeps the durable contract on the
schema side of the #1530 host-language rewrite boundary.

## PR 4 MAP Projection

PR 4 turns the PR 3 artifact contract into the first generated projection:
`.planning/codebase/MAP.md`. The generator selects a conformant
`codebase-map.v1` artifact, renders a banner-marked Markdown orientation map,
and records artifact/source digests so a separate freshness gate can compare
the projection against current canonical inputs.

Run:

```bash
task codebase:map
task verify:codebase-map-fresh
```

Provider configuration is deliberately artifact-at-a-path. Projects may set:

```json
{
  "plan": {
    "policy": {
      "projectionProviders": {
        "codebase-map": {
          "artifactPath": ".planning/codebase/provider-map.json",
          "expect": {
            "provider": "example-provider",
            "version": "1.0"
          }
        }
      }
    }
  }
}
```

Directive reads that artifact when present and treats `expect` as a validation
assertion. It does not store runner command strings in `projectionManifest[]`
or policy. Missing, invalid, mismatched, or stale provider artifacts fall back
to the default extractor. Freshness is no-network and no-model: provider
freshness signals are accepted when present, otherwise Directive compares
`source.contentHashes.files[]` against the current working tree. The fallback
extractor is always regenerated locally and carries a compact source digest.

## PR 6 Guidance Propagation

PR 6 propagates the MAP projection contract to agent-facing guidance. Agents may
read `.planning/codebase/MAP.md` as an orientation aid and may refresh it with
`task codebase:map` plus `task verify:codebase-map-fresh`, but the MAP remains a
projection. A stale or absent MAP is not a default blocker for unrelated
implementation work. When the MAP is wrong, the fix is to update
`plan.architecture.codeStructure` or the selected provider artifact, then
regenerate the projection.
