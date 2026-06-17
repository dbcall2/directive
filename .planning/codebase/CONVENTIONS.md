# Historical Codebase Conventions Note

Status: historical planning artifact.

This file is not the current conventions source of truth.

Current references:

- `docs/CONCEPTS.md` for current Deft operating principles.
- `docs/FILES.md` for the current repository layout.
- `main.md`, `AGENTS.md`, and the relevant `skills/*/SKILL.md` files for agent behavior.
- `coding/`, `languages/`, `interfaces/`, `tools/`, `scm/`, and `verification/` for maintained standards.
- `vbrief/vbrief.md` and `conventions/vbrief-filenames.md` for vBRIEF naming and lifecycle rules.

The old contents described early `run`-centric Python conventions, vBRIEF v0.5
shape, and legacy setup paths. The current implementation uses vBRIEF 0.6,
Taskfile-first command surfaces, `.deft/core/` consumer installs, and scoped
lifecycle folders under `vbrief/`.
