# CodeStructure Profile

Status: accepted for #1595 PR 2

Related: [#1595](https://github.com/deftai/directive/issues/1595), [#1498](https://github.com/deftai/directive/issues/1498), [#1618](https://github.com/deftai/directive/issues/1618), [#1379](https://github.com/deftai/directive/issues/1379)

## Purpose

`codeStructure` is authored codebase-structure metadata. It gives agents and
maintainers a stable module/path/pattern record without making source comments,
generated MAPs, or local indexes authoritative.

The PR 2 profile is intentionally limited to metadata shape and validation.
Brownfield extraction, MAP generation, generated headers, local indexes, and
consumer propagation are later slices of #1595.

## Physical Home

Directive dogfoods the profile only in:

```text
vbrief/PROJECT-DEFINITION.vbrief.json
```

The semantic JSON shape is:

```json
{
  "plan": {
    "architecture": {
      "codeStructure": {}
    }
  }
}
```

No standalone canonical `codeStructure` file is allowed. Standalone paths are
reserved for generated projections that are banner-marked, declared in
`projectionManifest[]`, and drift-checked or gitignored. The consumer namespace
fallback, `x-directive/architecture.codeStructure`, remains readable for
projects that cannot type `plan.architecture` yet, but Directive's own
canonical record uses `plan.architecture.codeStructure`.

## Shape

The profile schema is typed in `vbrief/schemas/vbrief-core.schema.json` under
`$defs.CodeStructure` and wired through `plan.architecture.codeStructure`.

Required keys:

- `version`: currently `"0.1"`
- `modules[]`: stable module ids, display names, purposes, path globs, and
  optional owners
- `pathOwnership[]`: explicit glob-to-module ownership records for cases where
  module-level globs are insufficient
- `allowedPatterns[]`: module-scoped implementation patterns or constraints
- `projectionManifest[]`: generated outputs planned or produced from the
  metadata; entries store `{ path, kind, generated, source }` and do not store
  runner-specific command strings

Optional keys:

- `filePurposeOverrides[]`: human overrides only, not a full per-file registry
- `glossaryRefs[]`: links to existing glossary/doc terms

Unknown future keys are valid and must be preserved by writers.

## Validation

Run:

```bash
task codebase:validate-structure
```

The validator checks stable ids, safe repository-relative globs and paths,
module references, duplicate ownership conflicts, projection manifest entries,
and unknown-key tolerance. It does not extract metadata from code and does not
generate projections.
