# CodeStructure Profile

Status: accepted for #1595 PR 2; extended by #1595 PR 3; current contract layer implemented

Related: [#1595](https://github.com/deftai/directive/issues/1595), [#1498](https://github.com/deftai/directive/issues/1498), [#1618](https://github.com/deftai/directive/issues/1618), [#1379](https://github.com/deftai/directive/issues/1379)

## Purpose

`codeStructure` is authored codebase-structure metadata. It gives agents and
maintainers a stable module/path/pattern record without making source comments,
generated MAPs, or local indexes authoritative.

The PR 2 profile was intentionally limited to metadata shape and validation.
PR 3 adds the contract layer between authored metadata and later projections:
a dependency-free default extractor, a provider artifact handshake, a
projection-kind registry, and discipline checks that keep authored
`codeStructure` focused on canonical intent. MAP rendering, generated headers,
local indexes, and consumer propagation are still later slices of #1595.

## Current Implementation Status

Implemented:

- `task codebase:validate-structure`
- `task codebase:extract-default`
- `task codebase:provider-map`
- `task codebase:projection-registry`
- `vbrief/schemas/codebase-map.schema.json`
- `tests/fixtures/codebase-map.v1.golden.json`

Planned / not yet implemented:

- `.planning/codebase/MAP.md` generation
- codebase-map freshness checks
- generated source headers
- local indexes
- consumer propagation of generated MAP artifacts

The `projectionManifest[]` entry for `.planning/codebase/MAP.md` is therefore
an intentional planned projection declaration, not proof that the projection
exists yet.

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
unknown-key tolerance, and PR 3 source-of-truth discipline. It hard-blocks known
derived-fact keys such as imports, coupling, file counts, languages, symbols, or
entry points from authored metadata. It also rejects multiple codeStructure
homes in one file, rejects codeStructure-bearing vBRIEF siblings during default
project discovery, verifies existing generated projections carry a generated
banner/source pointer, and checks glossary URIs when a project root is known.

Boundedness findings such as unusually large `filePurposeOverrides[]` are
warnings by default. Pass `--strict` through the task when a caller wants those
warnings to fail:

```bash
task codebase:validate-structure -- --strict
```

## Extraction Contract

Run:

```bash
task codebase:extract-default
```

The default extractor emits a `codebase-map.v1` JSON artifact to stdout. It
uses `codeStructure.modules[].pathGlobs` when available and falls back to
top-level repository directories when no authored metadata exists. Coupling,
entry points, and language distribution are derived with deterministic
repository walking and import-line or filename heuristics only; no network,
model, parser, or AST dependency is used. The artifact carries provenance and
degraded markers so later MAP rendering can distinguish authored intent from
heuristic facts.

Run:

```bash
task codebase:provider-map -- --provider-command "<provider argv>"
```

External providers may replace the default artifact only when they emit a JSON
object with `formatVersion: "codebase-map.v1"`,
`contractVersion: "codebase-provider.v1"`, `kind: "codebase-map"`, provider
metadata, source metadata, a non-empty `modules[]` array whose entries carry
`id`, `files`, and `derivedFrom`, and the tier-1 arrays `coupling[]`,
`entryPoints[]`, `languageDistribution[]`, and `degraded[]`. The
language-neutral JSON Schema at `vbrief/schemas/codebase-map.schema.json` is
the normative contract: `scripts/codebase_provider.py` validates provider
artifacts by interpreting that schema with a dependency-free local subset
validator, so the contract survives a future host-language rewrite instead of
living only in Python field checks. `tests/fixtures/codebase-map.v1.golden.json`
is the canonical example and regression fixture. Missing, failing, or
mismatched providers fall back to the default extractor instead of failing the
metadata validation path.

## Projection Registry

`projectionManifest[].kind` remains invocation-agnostic. For the first kind,
`codebase-map`, Directive owns the format and provider contract in
`scripts/codebase_projection_registry.py` and exposes it with:

```bash
task codebase:projection-registry -- --kind codebase-map
```

The registry stores semantic actions, not literal `task ...` command strings,
so canonical metadata stays portable across task-runner follow-ups.
