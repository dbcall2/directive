# cmd/deft-install conformance audit -- 2026-05-10 (v0.27.1)

Tracking issue: [#992](https://github.com/deftai/directive/issues/992)
Closing gate: `992-ac-6-installer-conformance` (active scope vBRIEF `vbrief/active/2026-05-10-992-adopt-deftcore-as-canonical-install-layout-ship-relocator-an.vbrief.json`)
Branch: `evidence/992-installer-audit` off `master @ af829f4` (tag `v0.27.1`)
Drift tracker: [#1020](https://github.com/deftai/directive/issues/1020) (filed during audit; adoption-blocker label)
Partner evidence: `evidence/992-rc1-dogfood` (relocator dogfood smoke, separate worker)

## Summary

Audited `cmd/deft-install/` (the Go installer at `cmd/deft-install/`) against the v0.27.1 canonical install layout pinned by the F2 self-bootstrap decision (PR [#1017](https://github.com/deftai/directive/pull/1017), `tests/relocate/test_self_bootstrap.py::TestF2GitignoreDefault`). Built the installer from the worktree at HEAD, ran it against a fresh `git init` greenfield consumer, and evaluated eight canonical-layout assertions (4a-4h).

**Headline: drifts-but-tracked.** 3 of 8 assertions pass; 5 fail. The installer deposits the framework at the legacy `deft/` path and does not manage the consumer's `.gitignore`. AGENTS.md is rendered from `templates/agents-entry.md` (which already carries marker v2 from PR1 #1010), so the marker-bump assertion passes. Per the dispatch envelope: drift does NOT block #992 closure; it is a fresh-adoption blocker tracked separately as [#1020](https://github.com/deftai/directive/issues/1020).

## Build output

Built from worktree `C:\Repos\deft\directive-992-audit` (master @ af829f4, tag v0.27.1):

```
go version
go version go1.26.2 windows/amd64

go build -ldflags "-X main.version=audit-v0.27.1 -X main.defaultBranch=v0.27.1" \
  -o C:\Temp\deft-install-audit.exe ./cmd/deft-install/
```

- Exit code: `0`
- Binary size: 9,722,368 bytes
- `deft-install-audit.exe --version` -> `deft-install audit-v0.27.1`

Build helper task: `tasks/install.yml` exposes `task install` which calls `go run ./cmd/deft-install/`. There is no dedicated `install:build` target, so the audit uses a raw `go build` with version + branch ldflags pinning the audit binary to the v0.27.1 framework ref.

## Greenfield consumer setup

```
$greenfield = "C:\Temp\audit-greenfield-96423"
New-Item -ItemType Directory -Path $greenfield -Force | Out-Null
git -C $greenfield init -q
Set-Content -Path "$greenfield\.gitignore" `
  -Value "# consumer pre-existing`nnode_modules/`n.env`n" `
  -Encoding UTF8
git -C $greenfield add -A
git -C $greenfield -c user.email=audit@deft -c user.name=audit commit -q `
  -m "fixture: pre-install state"
```

Pre-install state:

```
.git/         (consumer's own scm metadata)
.gitignore    (3 lines: "# consumer pre-existing", "node_modules/", ".env")
```

Commit `89293c8` on `master` carries the fixture. The greenfield lives outside the worktree (`C:\Temp\...`); no commits or pushes are made against it.

## Install invocation

```
$stdin = "audit-test`r`n2`r`n$greenfield`r`n1`r`ny`r`n"
[System.IO.File]::WriteAllText("$env:TEMP\deft-install-stdin.txt", $stdin)

Start-Process -FilePath "C:\Temp\deft-install-audit.exe" `
  -ArgumentList @("--debug","--branch","v0.27.1") `
  -RedirectStandardInput "$env:TEMP\deft-install-stdin.txt" `
  -RedirectStandardOutput "$env:TEMP\install-stdout.log" `
  -RedirectStandardError  "$env:TEMP\install-stderr.log" `
  -PassThru -Wait -NoNewWindow
```

The installer's wizard is interactive; the stdin script answers each prompt in order: project name (`audit-test`), starting-folder action `2` (type a path manually), the greenfield absolute path, action `1` (`** Install in this directory **`), then `y` to confirm.

- Exit code: `0`
- Stderr: empty
- Stdout (abridged):

```
[debug] OS=windows ARCH=amd64
[debug] defaultBranch=v0.27.1 branch=v0.27.1

Welcome to Deft! -- AI coding standards, installed in seconds.
Installer version: audit-v0.27.1
...
[debug] project=C:\Temp\audit-greenfield-96423 deft=C:\Temp\audit-greenfield-96423\deft
[debug] git found at C:\Program Files\Git\cmd\git.exe
Cloning deft (branch v0.27.1) into C:\Temp\audit-greenfield-96423\deft ...
Cloning into 'C:\Temp\audit-greenfield-96423\deft'...
Note: switching to 'af829f4ec5bbe6ef562722d76080bb94ba893f8e'.
...
AGENTS.md created.
.agents/skills/ created -- deft skills will be auto-discovered.

OK Deft installed successfully!

  Location     : C:\Temp\audit-greenfield-96423\deft\
  AGENTS.md    : updated
  Skills       : .agents/skills/ created (auto-discovered by AI agents)
  User config  : C:\Users\msadams\AppData\Roaming\deft\
```

Note: the `--branch v0.27.1` flag is honored by the wizard's clone step. The tag is annotated, so git checks out the underlying commit `af829f4` in detached HEAD -- semantically the same code as the v0.27.1 release.

## Conformance assertions

Post-install consumer root:

```
.agents/      (skill thin-pointer discovery dir)
.git/         (consumer's own scm metadata)
.gitignore    (3 lines: unchanged from fixture)
AGENTS.md     (newly created from templates/agents-entry.md)
deft/         (full framework deposit -- LEGACY layout)
```

### 4a -- `.deft/core/` framework deposit

Expected: `.deft/core/` present at consumer root with `skills/`, `scripts/`, `templates/`, `vbrief/schemas/`, etc.

Actual: **ABSENT.** `Test-Path "$greenfield\.deft"` -> `False`. The framework was deposited at `deft/` instead (see 4h).

Result: **FAIL.**

### 4b -- AGENTS.md managed-section marker v2

Expected: `AGENTS.md` at consumer root contains both `<!-- deft:managed-section v2 -->` and `<!-- /deft:managed-section -->`.

Actual: present.

```
Select-String -Path "$greenfield\AGENTS.md" -SimpleMatch `
  -Pattern '<!-- deft:managed-section v2 -->'    # match count: 1
Select-String -Path "$greenfield\AGENTS.md" -SimpleMatch `
  -Pattern '<!-- /deft:managed-section -->'      # match count: 1
```

First line of AGENTS.md: `<!-- deft:managed-section v2 -->`. The installer renders this from `templates/agents-entry.md` via the `templates.AgentsEntry` `//go:embed` (see `templates/embed.go`), so the marker bump from #992 PR1 (PR #1010) flows through automatically without an installer code change.

Result: **PASS.**

Caveat: the BODY of the marker-managed section still reads `Deft is installed in deft/. Full guidelines: deft/main.md` -- consistent with this installer's deposit at `deft/`, but inconsistent with the canonical contract that the framework lives at `.deft/core/`. The marker itself is conformant; the prose inside the marker is part of the broader drift tracked in #1020.

### 4c -- `.gitignore` contains `.deft-cache/`

Expected: `.deft-cache/` listed in `.gitignore`.

Actual: **ABSENT.** Final `.gitignore` body:

```
# consumer pre-existing
node_modules/
.env
```

The installer never modifies `.gitignore`. The F2 default is owned by `scripts/relocate.py::_ensure_gitignore_lines` (`GITIGNORE_LINES = (".deft-cache/", "vbrief/.eval/")`); the Go installer has no analogous step.

Result: **FAIL.**

### 4d -- `.gitignore` contains `vbrief/.eval/`

Expected: `vbrief/.eval/` listed in `.gitignore`.

Actual: **ABSENT.** Same root cause as 4c.

Result: **FAIL.**

### 4e -- `.gitignore` does NOT contain `.deft/core/`

Expected: `.deft/core/` MUST NOT be in `.gitignore` (per the relocator's explicit anti-pattern: `.deft/core/` is read-only packaged framework assets the consumer commits per #11).

Actual: vacuously satisfied. The installer never touches `.gitignore`, so the forbidden line is not present.

Result: **PASS** (vacuous).

### 4f -- Pre-existing `.gitignore` lines preserved

Expected: the three pre-seeded lines (`# consumer pre-existing`, `node_modules/`, `.env`) survive the install.

Actual: byte-for-byte preserved -- the file is untouched.

Result: **PASS.**

### 4g -- `vbrief/` at consumer root with `schemas/` + `vbrief.md`

Expected: a consumer-side `vbrief/` directory at root containing `schemas/` and `vbrief.md`, with no lifecycle subdirs (`active/`, `pending/`, etc.) pre-created (matches relocator behaviour via `VBRIEF_LIFECYCLE_DIRS`).

Actual: **ABSENT** at consumer root. The framework's own `vbrief/` exists at `deft/vbrief/` (inside the cloned framework copy) and includes lifecycle subdirs along with the schemas -- the wrong place for a fresh consumer to author scope vBRIEFs.

Result: **FAIL.**

### 4h -- Legacy `deft/` NOT created

Expected: `deft/` MUST NOT exist at the consumer root (canonical-only contract).

Actual: **PRESENT.** Top-level listing of `deft/`:

```
__pycache__, .agents, .git, .githooks, .github, .planning, cmd, coding, context,
contracts, conventions, core, deployments, docs, events, history, interfaces,
languages, meta, patterns, platforms, references, resilience, scm, scripts,
secrets, skills, specs, strategies, swarm, tasks, templates, tests, tools,
vbrief, verification, .gitignore, AGENTS.md, CHANGELOG.md, commands.md,
CONTRIBUTING.md, glossary.md, go.mod, LICENSE.md, main.md, PRD.md, PROJECT.md,
pyproject.toml, QUICK-START.md, README.md, REFERENCES.md, ROADMAP.md, run,
run.bat, run.py, session.txt, session2.txt, SKILL.md, SPECIFICATION.md,
Taskfile.yml, UPGRADING.md, uv.lock
```

Hardcoded in `cmd/deft-install/wizard.go:70`:

```go
deftDir := filepath.Join(projectDir, "deft")
```

Result: **FAIL** (this is the core drift).

### Summary table

- 4a `.deft/core/` deposit -- FAIL
- 4b AGENTS.md marker v2 -- PASS
- 4c `.gitignore` has `.deft-cache/` -- FAIL
- 4d `.gitignore` has `vbrief/.eval/` -- FAIL
- 4e `.gitignore` does NOT have `.deft/core/` -- PASS (vacuous)
- 4f pre-existing `.gitignore` preserved -- PASS
- 4g consumer-root `vbrief/` with `schemas/` + template -- FAIL
- 4h legacy `deft/` NOT created -- FAIL

3 PASS, 5 FAIL. The installer is producing what `scripts/_relocate_states.py::detect_install_state` classifies as **state A** (`pure deft/ (legacy install)`).

## Drift detection

Drift confirmed. Filed as [#1020 -- installer: cmd/deft-install drifts from v0.27.1 canonical layout (F2)](https://github.com/deftai/directive/issues/1020) with the `adoption-blocker` label. The drift issue body documents:

- the eight assertions and per-assertion results
- the hardcoded `deftDir` join in `cmd/deft-install/wizard.go:70`
- adjacent drift surfaces (`agentsMDSentinel = "deft/main.md"`, 9 thin-pointer skill `deft/skills/...` strings, no `.gitignore` upkeep, no consumer-root `vbrief/` deposit, no `.deft/core/` deposit)
- why this is NOT a #992 blocker (the relocator is the migration vehicle; a consumer who runs the Go installer then the relocator ends up canonical)
- recommended fix scope (separate cohort): 7-item checklist covering `wizard.go`, `setup.go`, `.gitignore` upkeep, `vbrief/` deposit, template prose, and a conformance test mirroring `TestF2GitignoreDefault`

## Conclusion

**Conformance status: drifts-but-tracked.** The `cmd/deft-install/` Go installer does not match the v0.27.1 canonical install layout pinned by the F2 decision. Five of eight conformance assertions fail. The installer produces a state-A install (pure legacy `deft/`) that the v0.27.1 relocator is built to migrate.

Per the audit dispatch envelope, this does NOT block cohort #992 closure: the relocator is the canonical migration path for fresh installs done with the Go binary today, and the drift is tracked separately as `adoption-blocker` issue #1020. Cohort #992 closes once the partner dogfood evidence (branch `evidence/992-rc1-dogfood`) and this audit both land.

## References

- PR [#1010](https://github.com/deftai/directive/pull/1010) -- v0.27.0 PR1 contract-string flip + managed-section marker v1 -> v2
- PR [#1013](https://github.com/deftai/directive/pull/1013) -- v0.27.0 PR2 wipe-and-reinstall relocator
- PR [#1017](https://github.com/deftai/directive/pull/1017) -- v0.27.1 relocator F2 self-bootstrap + `.gitignore` canonical default (the contract this audit verifies against)
- v0.27.1 release: https://github.com/deftai/directive/releases/tag/v0.27.1
- Issue [#992](https://github.com/deftai/directive/issues/992) -- adopt `.deft/core/` as canonical install layout (this audit's parent cohort)
- Issue [#1020](https://github.com/deftai/directive/issues/1020) -- drift tracker filed during this audit
- Active scope vBRIEF: `vbrief/active/2026-05-10-992-adopt-deftcore-as-canonical-install-layout-ship-relocator-an.vbrief.json` (acceptance criterion `992-ac-6-installer-conformance`)
- Companion dogfood evidence: branch `evidence/992-rc1-dogfood`
