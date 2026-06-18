# Historical Codebase Architecture Note

Status: historical planning artifact.

This file is not the current architecture source of truth.

Current references:

- `docs/ARCHITECTURE.md` for the implemented Deft Directive architecture.
- `docs/code-structure-profile.md` for the current `codeStructure` metadata profile.
- `docs/codebase-map-source-of-truth.md` for the MAP source-of-truth decision.
- `vbrief/PROJECT-DEFINITION.vbrief.json` `plan.architecture.codeStructure` for authored codebase-structure metadata.

`.planning/codebase/MAP.md` is declared as a planned generated projection, but
the MAP generator has not shipped yet. Until a generated MAP exists with a
machine-generated banner and source pointer, files in `.planning/codebase/`
should be treated as planning notes rather than authoritative architecture.

The old contents of this file described the early four-component project shape
and legacy `run`/`PROJECT.md`/`deft/` assumptions. Those assumptions no longer
match the implemented repository.
