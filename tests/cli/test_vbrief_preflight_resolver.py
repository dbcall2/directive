"""Tests for scripts/_resolve_preflight_path.py (#1046 PR-C AC-6 / #1047).

Covers the install-layout resolver's full state matrix:

- State B (canonical install at ``.deft/core/scripts/``) -- the highest
  priority candidate; the resolver MUST return this path when present
  even if lower-priority candidates also exist.
- State A (legacy install at ``deft/scripts/``) -- the second-priority
  candidate; the resolver MUST return this path when the canonical
  install is absent.
- In-repo case (the deft framework itself; ``scripts/``) -- the
  third-priority candidate; the resolver MUST return this path when
  both install locations are absent.
- All three absent -- the resolver MUST fail closed with a structured
  ``gate misconfigured`` error pointing at ``task framework:doctor``
  and exit non-zero. This is the load-bearing safety property: per
  issue #1047 the gate's failure mode before this PR was silent
  fail-open on every ``.deft/core/`` install, materially worse than
  the gate not existing because the agent's contract says #810 is
  in force.

The harness builds each layout with ``tmp_path`` so the resolver is
exercised end-to-end (file-system probes, priority order, fail-closed
exit) without touching the repository checkout the test runs from.

Mirrors the shape of ``tests/cli/test_resolve_version.py`` (#723)
which similarly tests a Taskfile-consumed resolver helper.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RESOLVER_PATH = REPO_ROOT / "scripts" / "_resolve_preflight_path.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def resolver():
    return _load_module("_resolve_preflight_path", RESOLVER_PATH)


# ---------------------------------------------------------------------------
# Layout builders
# ---------------------------------------------------------------------------


def _make_preflight_at(parent: Path) -> Path:
    """Write a placeholder ``preflight_implementation.py`` under ``parent``.

    The resolver only checks ``Path.is_file()`` -- it does NOT exec or
    parse the script -- so any non-empty file at the right location is
    sufficient to exercise the priority order.
    """
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / "preflight_implementation.py"
    target.write_text("# fixture stand-in for the real script\n", encoding="utf-8")
    return target


def _build_canonical_layout(root: Path) -> Path:
    """State B: framework installed at ``<root>/.deft/core/``."""
    return _make_preflight_at(root / ".deft" / "core" / "scripts")


def _build_legacy_layout(root: Path) -> Path:
    """State A: framework installed at ``<root>/deft/`` (legacy)."""
    return _make_preflight_at(root / "deft" / "scripts")


def _build_in_repo_layout(root: Path) -> Path:
    """In-repo: the deft framework itself is the project root."""
    return _make_preflight_at(root / "scripts")


# ---------------------------------------------------------------------------
# resolve_preflight_path() -- Python API
# ---------------------------------------------------------------------------


def test_canonical_layout_resolves_to_deft_core(resolver, tmp_path):
    """State B alone -> resolver returns the ``.deft/core/`` path."""
    expected = _build_canonical_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result is not None
    assert result == expected.resolve()


def test_legacy_layout_resolves_to_deft(resolver, tmp_path):
    """State A alone -> resolver returns the legacy ``deft/`` path."""
    expected = _build_legacy_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result is not None
    assert result == expected.resolve()


def test_in_repo_layout_resolves_to_scripts(resolver, tmp_path):
    """In-repo only -> resolver returns the ``scripts/`` path."""
    expected = _build_in_repo_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result is not None
    assert result == expected.resolve()


def test_priority_canonical_wins_over_legacy(resolver, tmp_path):
    """Canonical AND legacy present -> canonical wins."""
    canonical = _build_canonical_layout(tmp_path)
    legacy = _build_legacy_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result == canonical.resolve()
    assert result != legacy.resolve()


def test_priority_canonical_wins_over_in_repo(resolver, tmp_path):
    """Canonical AND in-repo present -> canonical wins."""
    canonical = _build_canonical_layout(tmp_path)
    in_repo = _build_in_repo_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result == canonical.resolve()
    assert result != in_repo.resolve()


def test_priority_legacy_wins_over_in_repo(resolver, tmp_path):
    """Legacy AND in-repo present (no canonical) -> legacy wins."""
    legacy = _build_legacy_layout(tmp_path)
    in_repo = _build_in_repo_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result == legacy.resolve()
    assert result != in_repo.resolve()


def test_priority_all_three_present_canonical_wins(resolver, tmp_path):
    """All three layouts present -> canonical wins (highest priority)."""
    canonical = _build_canonical_layout(tmp_path)
    _build_legacy_layout(tmp_path)
    _build_in_repo_layout(tmp_path)
    result = resolver.resolve_preflight_path(tmp_path)
    assert result == canonical.resolve()


def test_all_layouts_absent_returns_none(resolver, tmp_path):
    """No candidate resolves -> resolver returns None (API contract)."""
    # tmp_path is empty -- no .deft/core/, no deft/, no scripts/.
    assert resolver.resolve_preflight_path(tmp_path) is None


def test_directory_at_candidate_path_is_not_a_match(resolver, tmp_path):
    """A directory (not a regular file) at the candidate path is NOT a match.

    Defends against a misconfigured install where ``.deft/core/scripts/``
    exists as a directory but ``preflight_implementation.py`` is a
    directory rather than a file -- the resolver's ``Path.is_file()``
    probe rejects directories, so the resolver falls through to the
    next candidate.
    """
    canonical_scripts = tmp_path / ".deft" / "core" / "scripts"
    (canonical_scripts / "preflight_implementation.py").mkdir(parents=True)
    legacy = _build_legacy_layout(tmp_path)
    # The directory-at-canonical entry is skipped; legacy wins.
    result = resolver.resolve_preflight_path(tmp_path)
    assert result == legacy.resolve()


def test_relative_project_root_resolves_to_absolute(resolver, tmp_path, monkeypatch):
    """A relative ``project_root`` (e.g. ``"."``) is normalised to absolute."""
    expected = _build_canonical_layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    result = resolver.resolve_preflight_path(Path("."))
    assert result is not None
    assert result == expected.resolve()
    assert result.is_absolute()


# ---------------------------------------------------------------------------
# main() / CLI -- exit-code contract
# ---------------------------------------------------------------------------


def test_main_resolved_prints_path_on_stdout(resolver, tmp_path, capsys):
    """Resolution success -> stdout carries the absolute path, exit 0, stderr clean."""
    expected = _build_canonical_layout(tmp_path)
    code = resolver.main(["--project-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0
    assert captured.err == ""
    # Stdout is the raw absolute path with NO trailing newline (so the
    # Taskfile body can capture it via $(...) verbatim).
    assert captured.out == str(expected.resolve())
    assert not captured.out.endswith("\n")


def test_main_fail_closed_exits_2(resolver, tmp_path, capsys):
    """No candidate resolves -> exit 2, stdout clean, stderr has structured error."""
    # tmp_path is empty.
    code = resolver.main(["--project-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    # Structured error MUST name the failure class + point at the
    # diagnostic surface so operators (and downstream parsers) classify
    # the exit without parsing free-form text.
    assert "gate misconfigured" in captured.err
    assert "preflight_implementation.py" in captured.err
    assert "task framework:doctor" in captured.err


def test_main_fail_closed_enumerates_probed_layouts(resolver, tmp_path, capsys):
    """Fail-closed message enumerates all three probed layouts.

    Operators staring at the error on a misconfigured install need to
    see WHICH locations the resolver tried so they can diagnose whether
    they have a v0.27 canonical install drifted out of place, a legacy
    install with the wrong directory name, or an in-repo invocation
    from the wrong working directory.
    """
    resolver.main(["--project-root", str(tmp_path)])
    captured = capsys.readouterr()
    # Each of the three canonical subpath prefixes MUST appear in the
    # operator-facing error so the diagnostic is self-describing. The
    # in-repo assertion uses a uniquely-anchored substring (`, scripts/`
    # -- the comma-separated list-element form `_resolve_preflight_path`
    # emits, e.g. `(.deft/core/scripts/, deft/scripts/, scripts/)`) so
    # the check cannot be vacuously satisfied by the trailing
    # `scripts/` already present inside `.deft/core/scripts/` and
    # `deft/scripts/` (Greptile review of PR #1058).
    assert ".deft/core/scripts/" in captured.err
    assert "deft/scripts/" in captured.err
    assert ", scripts/" in captured.err or " scripts/)" in captured.err


def test_main_default_project_root_is_cwd(resolver, tmp_path, capsys, monkeypatch):
    """Omitting ``--project-root`` defaults to the current working directory."""
    expected = _build_canonical_layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    code = resolver.main([])
    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == str(expected.resolve())


def test_main_resolves_legacy_layout(resolver, tmp_path, capsys):
    """State A install -> CLI resolves to the ``deft/`` legacy path."""
    expected = _build_legacy_layout(tmp_path)
    code = resolver.main(["--project-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == str(expected.resolve())


def test_main_resolves_in_repo_layout(resolver, tmp_path, capsys):
    """In-repo case -> CLI resolves to the ``scripts/`` in-repo path."""
    expected = _build_in_repo_layout(tmp_path)
    code = resolver.main(["--project-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == str(expected.resolve())


# ---------------------------------------------------------------------------
# Self-test: against the REAL deft repo (in-repo case)
# ---------------------------------------------------------------------------


def test_self_resolves_against_real_repo_root(resolver):
    """Against the deft repo root the resolver MUST return the in-repo script.

    This is the recursively-appropriate self-test: the resolver is part
    of the framework, and running it against the framework checkout
    MUST surface the in-repo ``scripts/preflight_implementation.py``.
    If this test fails, the resolver's priority order or candidate-list
    has drifted away from the canonical contract.

    The in-repo deft checkout has no ``.deft/core/`` or ``deft/``
    subdirectory at the root, so the resolver falls through to the
    in-repo case. If a future change adds a sibling ``.deft/`` directory
    to the framework checkout (e.g. an embedded toolchain), this
    assertion MUST be revisited.
    """
    expected = REPO_ROOT / "scripts" / "preflight_implementation.py"
    assert expected.is_file(), (
        f"Expected the in-repo preflight script at {expected}; the "
        f"self-test cannot run without it on disk."
    )
    result = resolver.resolve_preflight_path(REPO_ROOT)
    assert result is not None
    assert result == expected.resolve()
