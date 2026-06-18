# Historical Codebase Stack Note

Status: historical planning artifact.

This file is not the current technology inventory.

Current references:

- `README.md` for user-facing platform and installer requirements.
- `pyproject.toml` and `uv.lock` for Python tooling dependencies.
- `go.mod` and `cmd/deft-install/` for the Go installer.
- `Taskfile.yml` and `tasks/*.yml` for the command graph.
- `.github/workflows/` and `.githooks/` for CI and local enforcement.
- `docs/ARCHITECTURE.md` and `docs/FILES.md` for the current module and file map.

The old contents named obsolete version values and described Markdown as the
whole product. The current implementation is a Taskfile-first framework with
agent guidance, vBRIEF metadata, Python automation, a Go installer, content
packs, local cache/triage workflows, and CI/release automation.
