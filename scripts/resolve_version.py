#!/usr/bin/env python3
"""resolve_version.py -- Python runtime VERSION resolver
plus the canonical semver -> PEP 440 normalization helper (#771).

This script is the Python runtime resolver for Deft entry points that
need a framework version outside the Taskfile build pipeline. It began
as an independent Python mirror of the Taskfile-side release-build
resolver. The Python/runtime chain reads durable installed version files
so git-free payload installs can report the release they actually carry
even when their parent consumer repository has no Deft tags.

This Python module is NOT invoked from ``Taskfile.yml``. The Taskfile
inline POSIX ``sh:`` block remains the resolver consumed by
``task build`` / ``task release`` (run via go-task's embedded
mvdan/sh interpreter so it works cross-platform without requiring
``uv`` / Python at parse time). Python callers should use this module
instead of reimplementing installed-payload detection.

Resolution priority (first match wins):
    1. ``$DEFT_RELEASE_VERSION`` -- set by ``scripts/release.py::run_build``
       so the in-flight release version (e.g. ``0.21.0``) becomes the
       build artifact filename during ``task release -- 0.21.0``. The
       Taskfile literal previously hard-coded ``0.20.0``, which produced an
       incorrect artifact filename during the next release.
    2. ``<install-root>/VERSION`` manifest ``tag`` / ``ref`` -- canonical
       installed version source for git-free payload installs.
    3. ``<install-root>/.deft-version`` -- legacy/plain installed marker.
    4. ``<install-root>/pyproject.toml`` ``[project].version`` -- release
       metadata shipped with plain-file payloads.
    5. ``git describe --tags --abbrev=0`` (stripped of leading ``v``) --
       only when ``<install-root>`` is itself a Git checkout, so consumer
       repo tags are never mistaken for Deft release tags.
    6. ``0.0.0-dev`` -- fallback for fresh checkouts with no tags or
       repositories where ``git`` is unavailable.

The script writes the resolved version to stdout WITHOUT a trailing
newline so callers receive the same ``printf '%s'`` shape used by the
Taskfile inline ``sh:`` block. ``stderr`` is intentionally silent on
the happy path.

If you change the release-build priority chain here, consider whether
the inline ``sh:`` block in ``Taskfile.yml`` needs the same change. The
installed-payload branches are intentionally Python-runtime only.

PEP 440 normalization (#771)
----------------------------
``to_pep440(version)`` is the SINGLE CANONICAL converter from deft's
semver-shaped release tags (``vX.Y.Z`` / ``vX.Y.Z-rc.N`` / etc.) to
Python-package-safe PEP 440 versions. It is consumed by:

    * ``scripts/release.py`` Step 5 -- syncs ``[project].version`` in
      ``pyproject.toml`` so the root metadata stops drifting from the
      released tag (Phase A of #771);
    * ``tests/content/test_pyproject_version_freshness.py`` -- regression
      gate that fails if pyproject drifts;
    * any FUTURE pip-packaging path (root-repo or thin wrapper, see #11)
      MUST consume ``to_pep440`` rather than reimplementing the rule --
      this is the documented Phase C extension hook so exactly ONE
      normalization rule governs release-tag / CLI / PyPI surfaces.

Disposable / test-only tags (``v0.0.0-test.N``, etc.) are explicitly
classified non-publishable: ``to_pep440`` raises
``NonPublishableVersionError`` and ``is_publishable`` returns False.
The release pipeline catches this and skips the pyproject sync rather
than emitting a polluting throwaway version.

Refs #723, #74 (release foundation), #716 (safety hardening), #721
(canonical recovery anchor for the v0.21.0 cut session), #771
(pyproject truthfulness + PEP 440 normalization), #11 (future pip
packaging consumes this helper).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

DEV_FALLBACK = "0.0.0-dev"
ENV_VAR = "DEFT_RELEASE_VERSION"
_MANIFEST_LINE_RE = re.compile(r"^\s*(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<value>.*?)\s*$")
_PYPROJECT_VERSION_RE = re.compile(r"^\s*version\s*=\s*['\"](?P<value>[^'\"]+)['\"]\s*$")

# Framework install root for installed version file lookups.
# This script lives at ``<install>/scripts/resolve_version.py``; its parent's
# parent is the framework deposit (``<install>``) where the Go installer
# writes the canonical ``VERSION`` manifest and the bare ``.deft-version``
# derivative. In framework-self-dev the same path resolves to the repo root.
_FRAMEWORK_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# PEP 440 normalization (#771)
# ---------------------------------------------------------------------------

# Accepts an optional leading ``v`` followed by strict ``X.Y.Z`` and an
# optional pre-release suffix ``-(rc|alpha|beta|test).N``. ``-test.N``
# is parsed (so we can classify it explicitly) but is NEVER mapped to a
# PEP 440 form -- see ``_NON_PUBLISHABLE_KINDS`` below.
_PEP440_TAG_RE = re.compile(
    r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)"
    r"(?:-(?P<kind>rc|alpha|beta|test)\.(?P<num>\d+))?$"
)

# Mapping from the semver-style pre-release token to PEP 440's compressed
# spelling. PEP 440 collapses ``rc.3`` -> ``rc3`` (no separator) and
# spells ``alpha`` / ``beta`` as ``a`` / ``b``.
_PRE_KIND_MAP: dict[str, str] = {
    "alpha": "a",
    "beta": "b",
    "rc": "rc",
}

# Pre-release tokens that classify a tag as non-publishable. ``test.N``
# is reserved for disposable / e2e-rehearsal tags (e.g. ``v0.0.0-test.1``
# from ``task release:e2e``) -- the release pipeline MUST skip the
# pyproject sync for these so PyPI / consumer-visible metadata is never
# polluted with throwaway versions.
_NON_PUBLISHABLE_KINDS: frozenset[str] = frozenset({"test"})


class NonPublishableVersionError(ValueError):
    """Raised when a tag is classified as non-publishable for PyPI.

    The release pipeline catches this in ``scripts/release.py`` Step 5
    and skips the ``pyproject.toml`` ``[project].version`` rewrite so
    disposable-tag releases (e.g. ``v0.0.0-test.1`` from the e2e
    rehearsal harness) never leak into Python-packaging metadata.

    Subclassing ``ValueError`` keeps catch-blocks that already trap
    ``ValueError`` (e.g. argparse error reporting) backward compatible;
    callers that need to distinguish the publishability classification
    from a generic parse failure check the concrete type.
    """


def to_pep440(version: str) -> str:
    """Normalize a semver-shaped release tag to a PEP 440 version string.

    Mappings (#771 acceptance):

        ``v0.22.0``         -> ``"0.22.0"``
        ``v0.20.0-rc.3``    -> ``"0.20.0rc3"``
        ``v0.20.0-beta.2``  -> ``"0.20.0b2"``
        ``v0.20.0-alpha.1`` -> ``"0.20.0a1"``
        ``v0.0.0-test.1``   -> raises ``NonPublishableVersionError``

    The leading ``v`` is optional (matching ``_from_git`` which strips
    it) so callers can pass either ``v0.22.0`` or ``0.22.0``.

    Raises
    ------
    NonPublishableVersionError
        For ``test.N`` (and any other ``_NON_PUBLISHABLE_KINDS``) tags.
    ValueError
        For anything that does not parse as ``[v]X.Y.Z[-(rc|alpha|beta|test).N]``.
    """
    if not isinstance(version, str):
        raise ValueError(f"version must be a string, got {type(version).__name__}")
    candidate = version.strip()
    if not candidate:
        raise ValueError("version must be a non-empty string")
    match = _PEP440_TAG_RE.match(candidate)
    if match is None:
        raise ValueError(
            f"Cannot normalize {candidate!r} to PEP 440: expected "
            f"[v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta|test).N"
        )
    base = f"{int(match['major'])}.{int(match['minor'])}.{int(match['patch'])}"
    kind = match.group("kind")
    if kind is None:
        return base
    if kind in _NON_PUBLISHABLE_KINDS:
        raise NonPublishableVersionError(
            f"Version {candidate!r} carries non-publishable pre-release "
            f"tag {kind!r}.{match.group('num')} -- release pipeline MUST "
            f"skip pyproject.toml [project].version sync for this tag."
        )
    # Greptile advisory (#774): defensive .get() guard so a future regex
    # extension that adds a kind without registering a mapping raises a
    # clean ValueError instead of a bare KeyError. _PEP440_TAG_RE and
    # _PRE_KIND_MAP / _NON_PUBLISHABLE_KINDS are kept in lockstep by
    # convention; this guard converts a contract drift into an actionable
    # diagnostic for the next maintainer.
    pep_kind = _PRE_KIND_MAP.get(kind)
    if pep_kind is None:
        raise ValueError(
            f"Unmapped pre-release kind {kind!r} for version {candidate!r}; "
            "add it to _PRE_KIND_MAP or _NON_PUBLISHABLE_KINDS to keep "
            "_PEP440_TAG_RE in lockstep with the publishability classifier."
        )
    pep_num = int(match.group("num"))
    return f"{base}{pep_kind}{pep_num}"


def is_publishable(version: str) -> bool:
    """Return True iff ``version`` normalizes to a publishable PEP 440 string.

    A return of False means the caller MUST NOT propagate ``version`` to
    PyPI-facing metadata (e.g. ``pyproject.toml`` ``[project].version``).
    Both ``NonPublishableVersionError`` and a generic parse ``ValueError``
    classify as non-publishable -- a malformed tag is not safe to publish.
    """
    try:
        to_pep440(version)
    except (NonPublishableVersionError, ValueError):
        return False
    return True


# ---------------------------------------------------------------------------
# Resolver priority chain (#723)
# ---------------------------------------------------------------------------


def _from_env() -> str | None:
    value = os.environ.get(ENV_VAR, "").strip()
    return value or None


def _normalise_resolved_version(raw: str, *, allow_dev: bool = False) -> str | None:
    """Return a bare version candidate, or None when the value is unusable."""
    candidate = raw.strip().strip("'\"")
    if candidate.startswith("v"):
        candidate = candidate[1:]
    if not candidate:
        return None
    if candidate == DEV_FALLBACK and not allow_dev:
        return None
    if not allow_dev and not candidate[0].isdigit():
        return None
    return candidate


def _default_install_root() -> Path:
    """Return the framework root for this script in source or install layout."""
    return _FRAMEWORK_ROOT


def _from_install_manifest(install_root: Path) -> str | None:
    """Return ``<install-root>/VERSION`` tag/ref as installed version."""
    manifest_path = install_root / "VERSION"
    if not manifest_path.is_file():
        return None
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError:
        return None

    parsed: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _MANIFEST_LINE_RE.match(stripped)
        if match is None:
            continue
        parsed[match.group("key").lower()] = match.group("value").strip()

    for key in ("tag", "ref"):
        raw = parsed.get(key)
        if raw is None:
            continue
        value = _normalise_resolved_version(raw)
        if value:
            return value
    return None


def _from_manifest(install_root: Path | None = None) -> str | None:
    """Compatibility alias for the installed manifest resolver."""
    root = Path(install_root) if install_root is not None else _default_install_root()
    return _from_install_manifest(root)


def _from_plain_marker(install_root: Path) -> str | None:
    """Return ``<install-root>/.deft-version`` when present."""
    marker_path = install_root / ".deft-version"
    if not marker_path.is_file():
        return None
    try:
        return _normalise_resolved_version(marker_path.read_text(encoding="utf-8"))
    except OSError:
        return None


def _from_deft_version(install_root: Path | None = None) -> str | None:
    """Compatibility alias for the installed-version marker helper."""
    root = Path(install_root) if install_root is not None else _default_install_root()
    return _from_plain_marker(root)


def _from_pyproject(install_root: Path) -> str | None:
    """Return ``[project].version`` from a shipped pyproject.toml."""
    pyproject_path = install_root / "pyproject.toml"
    if not pyproject_path.is_file():
        return None
    try:
        text = pyproject_path.read_text(encoding="utf-8")
    except OSError:
        return None

    in_project_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        content_line = stripped.split("#", 1)[0].strip()
        if content_line.startswith("[") and content_line.endswith("]"):
            in_project_section = content_line == "[project]"
            continue
        if not in_project_section:
            continue
        match = _PYPROJECT_VERSION_RE.match(content_line)
        if match is not None:
            return _normalise_resolved_version(match.group("value"))
    return None


def _git_top_level(install_root: Path) -> Path | None:
    """Return Git top-level only when git can resolve it from install_root."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            cwd=str(install_root),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    top_level = (result.stdout or "").strip()
    if not top_level:
        return None
    return Path(top_level)


def _from_git(install_root: Path | None = None) -> str | None:
    """Return the latest annotated tag only for standalone checkouts."""
    root = Path(install_root) if install_root is not None else _default_install_root()
    top_level = _git_top_level(root)
    try:
        if top_level is None or top_level.resolve() != root.resolve():
            return None
    except OSError:
        return None

    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            cwd=str(root),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    return _normalise_resolved_version(result.stdout or "")


def resolve_version(install_root: Path | None = None) -> str:
    """Resolve the version using the documented priority chain."""
    env_value = _from_env()
    if env_value:
        return _normalise_resolved_version(env_value, allow_dev=True) or env_value

    root = Path(install_root) if install_root is not None else _default_install_root()
    for resolver in (
        _from_manifest,
        _from_deft_version,
        _from_pyproject,
        _from_git,
    ):
        value = resolver(root)
        if value:
            return value
    return DEV_FALLBACK


def main(argv: list[str] | None = None) -> int:
    # No flags today; argv is accepted for symmetry with sibling scripts
    # that follow the argparse convention.
    del argv
    sys.stdout.write(resolve_version())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
