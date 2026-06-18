# Codebase MAP Source of Truth

Status: accepted for #1595 PR 1; contract layer implemented through #1595 PR 3

Date: 2026-06-12

Related: [#958](https://github.com/deftai/directive/issues/958), [#1492](https://github.com/deftai/directive/issues/1492), [#1498](https://github.com/deftai/directive/issues/1498), [#1595](https://github.com/deftai/directive/issues/1595), [#1618](https://github.com/deftai/directive/issues/1618), [#1379](https://github.com/deftai/directive/issues/1379)

## Decision

Directive will preserve the orientation goal from #958, but will not implement
hand-authored source file headers as the authoritative store for codebase
structure.

The durable source of truth for module ownership, path ownership, allowed
patterns, and projection outputs belongs in vBRIEF-owned architecture metadata.
The first implementation tracker for that path is #1595.

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

Still planned:

- Generated `.planning/codebase/MAP.md`.
- Freshness checks for that generated MAP.
- Generated source headers.
- Consumer-facing propagation of generated codebase projections.

This means the source-of-truth decision has landed, and the pre-MAP contract
layer has landed, but generated MAP output has not.

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

Steps 1-3 are complete in the current repository. Steps 4-6 remain future
work.

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
schema side of the #1530 host-language rewrite boundary. This is still pre-MAP:
`.planning/codebase/MAP.md` generation and freshness checks remain the next
slice.
