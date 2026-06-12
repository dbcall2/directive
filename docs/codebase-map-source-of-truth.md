# Codebase MAP Source of Truth

Status: accepted for #1595 PR 1

Date: 2026-06-12

Related: [#958](https://github.com/deftai/directive/issues/958), [#1492](https://github.com/deftai/directive/issues/1492), [#1498](https://github.com/deftai/directive/issues/1498), [#1595](https://github.com/deftai/directive/issues/1595)

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

Preferred home, aligned with #1498 and the #1492 schema-home discussion:

```json
{
  "plan": {
    "architecture": {
      "codeStructure": {}
    }
  }
}
```

If upstream vBRIEF does not accept architecture metadata in core immediately,
Directive may use the reserved consumer extension namespace as a temporary
compatibility path:

```json
{
  "x-directive/architecture": {
    "codeStructure": {}
  }
}
```

The extension namespace is a fallback, not the preferred long-term home.

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
3. Add a dry-run-first brownfield extractor that proposes metadata changes.
4. Generate the codebase MAP from metadata and code-derived facts.
5. Add optional generated headers only if the MAP leaves a concrete gap.
6. Update skills, docs, and consumer-facing guidance after a dogfood window.

## Non-Goals

- mandatory hand-authored file headers
- a default `task check` failure for missing headers
- a glossary or comment-semantics redesign
- full source-code generation from vBRIEF metadata
- AST support for every language in the first implementation slice

## PR 2 Hand-Off

The next PR should define the first concrete `codeStructure` schema/profile and
its validation behavior. It should remain focused on metadata shape and
round-trip preservation, not extraction or MAP rendering.
