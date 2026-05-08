# Contributing to Deft

Guide for setting up a development environment, running tests, and building the project.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Prerequisites

The following tools must be installed before working on Deft:

- **Go 1.22+** — required for building the installer (`cmd/deft-install/`)
- **Python 3.11+** — required for the CLI (`run`) and test suite
- **uv** — Python package manager and task runner ([docs.astral.sh/uv](https://docs.astral.sh/uv))
- **task** — Taskfile runner ([taskfile.dev](https://taskfile.dev))

Verify your toolchain:

```bash
go version        # go1.22 or later
python --version  # Python 3.11 or later
uv --version      # any recent version
task --version    # any recent version
```

## Windows quickstart (#902)

A fresh Windows maintainer can bootstrap the entire toolchain with a single command. This wraps the canonical `winget` package ids for Go, Python 3.12, uv, Task, and the GitHub CLI, then refreshes the running shell's `PATH` so the new binaries are visible without launching a new session.

One-line bootstrap (preferred):

```powershell
task setup:toolchain
```

Or invoke the script directly:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
```

The script is **idempotent**: it probes each tool via `Get-Command` first and only invokes `winget install` when the binary is missing. Re-running on a fully-provisioned machine prints an `Already present: ...` summary and exits 0. Each `winget install` runs with `--silent --accept-source-agreements --accept-package-agreements` so the bootstrap is non-interactive and CI-friendly.

If you launched your shell **before** running the bootstrap (or before any `winget install`), refresh the in-process `PATH` from the registry without restarting:

```powershell
. scripts\refresh-path.ps1
```

The helper merges the system PATH (`HKLM:\System\CurrentControlSet\Control\Session Manager\Environment\Path`) and user PATH (`HKCU:\Environment\Path`), de-duplicates while preserving order, and assigns `$env:PATH` in the current session. This is the same registry-key contract the Go installer's `refreshPathFromRegistry()` helper uses (#899) -- both surfaces read from the exact same two keys.

### Manual fallback (no winget)

If `winget` is unavailable on your host, install each tool from its official source:

- **Go** -- https://go.dev/dl/
- **Python 3.12+** -- https://www.python.org/downloads/windows/
- **uv** -- https://docs.astral.sh/uv/getting-started/installation/
- **Task** -- https://taskfile.dev/installation/
- **GitHub CLI** -- https://cli.github.com/

After each install, dot-source `scripts\refresh-path.ps1` to pick up the new entries without restarting your shell.

## Dev Environment Setup

1. Clone the repository:

```bash
git clone https://github.com/deftai/directive.git
cd directive
```

2. Install Python dependencies:

```bash
uv sync
```

3. Verify everything works:

```bash
task check
```

## Running Tests

Run the test suite:

```bash
task test
```

Run tests with coverage reporting:

```bash
task test:coverage
```

### The `task check` Gate

! `task check` is the **authoritative pre-commit gate**. It runs validation, linting, and the full test suite in sequence:

```bash
task check    # runs: validate + lint + test
```

! A passing `task check` is the **definition of ready-to-commit**. Do not commit unless `task check` passes.

⊗ Commit code that has not passed `task check`.

### Slow tests (#975)

Deft uses a `slow` pytest marker to keep `task check` fast on tight-loop iteration. Tests that exceed ~1s wall-clock (e.g. real `time.sleep` / thread-join waits in the watchdog regression suite) are marked with `@pytest.mark.slow` and **excluded by default** from `task check` via `addopts = "-m 'not slow'"` in `pyproject.toml`. The current marker users in `tests/integration/test_triage_bootstrap_at_scale.py` and `tests/test_triage_bootstrap.py` range from ~0.5s to ~1.9s; the **1s threshold is the contributor decision point**, not a hard floor on which existing tests qualify.

```bash
task check        # default lane -- skips @pytest.mark.slow tests (fast)
task check:slow   # slow lane -- runs only @pytest.mark.slow tests
```

! When a test you write exceeds ~1s, mark it with `@pytest.mark.slow` or refactor it to use injected clocks / `monkeypatch` so it runs in milliseconds. The slow lane is intended as a stop-gap; the long-term fix for any genuinely slow test is to remove the wall-clock dependency, not to leave the marker in place forever.

~ Run `task check:slow` locally before pushing changes that touch any `@pytest.mark.slow` test (or the watchdog / threading code those tests cover) so the slow lane stays green. CI runs both lanes.

~ When profiling a suite that feels slow, run `pytest <file> --durations=20` (or the equivalent `task` invocation) to see the top wall-clock offenders. If a single test exceeds 1s, mark it `@pytest.mark.slow` or refactor it before merging.

⊗ Add `@pytest.mark.slow` to tests that are fast but flaky -- the marker is for genuine wall-clock cost, not for hiding intermittent failures. Flaky tests should be fixed at the root cause.

## Running CLI Locally

The Deft CLI is a Python script at the repo root. Run it with:

```bash
uv run python run
```

Available CLI commands:

```bash
uv run python run bootstrap    # Set up user preferences
uv run python run project      # Configure project settings (writes PROJECT-DEFINITION.vbrief.json)
uv run python run spec         # Generate specification via AI interview (produces scope vBRIEFs)
uv run python run validate     # Check deft configuration
uv run python run doctor       # Check system dependencies
```

## Building the Go Installer

The Go installer lives in `cmd/deft-install/`. Build it with:

```bash
go build ./cmd/deft-install/
```

This produces a `deft-install` binary (or `deft-install.exe` on Windows) in the current directory.

To run the installer directly without building first:

```bash
go run ./cmd/deft-install/
```

To run the installer's tests:

```bash
go test ./cmd/deft-install/
```
