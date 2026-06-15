# Codebase MAP Source of Truth

Status: accepted for #1595 PR 1

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

Directive home, aligned with the vBRIEF 0.6 extension namespace rule:

```json
{
  "x-directive/architecture": {
    "codeStructure": {}
  }
}
```

If upstream vBRIEF later accepts architecture metadata in core, the same profile
can migrate to a core home such as:

```json
{
  "plan": {
    "architecture": {
      "codeStructure": {}
    }
  }
}
```

Until then, `x-directive/architecture.codeStructure` is the conformant home for
Directive-authored metadata.

### Home is provisional pending the source-of-truth/projection split (#1618)

This section names a JSON *shape* (`x-directive/architecture.codeStructure`), not a
commitment to physically embed that shape in the `PROJECT-DEFINITION.vbrief.json`
monolith. RFC #1618 argues that file is already overloaded (a large, drifting
`plan.items` registry), and that authored truth should live in small,
git-tracked, per-concern files while derived facts move to a rebuildable local
index. Two constraints follow for the PR-2 schema work:

- **Authored `codeStructure` intent** (modules, path ownership, allowed
  patterns, human overrides) is vBRIEF-owned and git-tracked, but SHOULD be free
  to live in its own file (e.g. a dedicated `architecture` vBRIEF or per-module
  files) rather than being welded into the `plan` blob. The final physical home
  is decided with #1618 / #1379, not frozen here.
- **Code-derived facts** (file-to-module inference, MAP contents, freshness and
  drift state) are projections, not authored truth. They belong in the
  rebuildable index proposed by #1618 and MUST NOT be committed as git-tracked
  metadata.

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

It MUST also resolve the physical metadata home in light of #1618 / #1379 (own
file vs. embedded in `plan`) and keep `filePurposeOverrides[]` an overrides-only
surface, per the "Home is provisional" note above.
