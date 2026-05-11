#!/usr/bin/env python3
"""_resolve_preflight_path.py -- resolve preflight_implementation.py
(#1046 PR-C AC-6 / absorbs #1047).

Probes for the wrapped ``preflight_implementation.py`` script in three
canonical locations under the supplied project root and prints the
resolved absolute path on stdout, OR exits non-zero with a structured
fail-closed error message that names the failure class and points the
operator at ``task framework:doctor`` (the PR-B install-integrity probe
landed in #1057).

Why this helper exists
----------------------

The Implementation Intent Gate (#810) is a safety gate, not a routing
gate. Its failure mode is silent fail-open: if the Taskfile target
``tasks/vbrief.yml::preflight`` wraps a hardcoded path that does not
resolve on the consumer's install layout, ``task vbrief:preflight``
either errors loudly (and the agent treats the gate as unreachable and
routes around it) or accidentally returns exit 0 (the gate emits
"preflight passed" reasoning without ever evaluating the vBRIEF). Per
issue #1047 the agent-side contract says #810 is in force on every
``.deft/core/`` install, but the gate was structurally unreachable on
those installs.

Three layouts must resolve correctly:

    1. ``<project-root>/.deft/core/scripts/preflight_implementation.py``
       -- the v0.27+ canonical install layout (#992).
    2. ``<project-root>/deft/scripts/preflight_implementation.py`` --
       the legacy v0.20-v0.26 install layout.
    3. ``<project-root>/scripts/preflight_implementation.py`` -- the
       in-repo case when the deft framework itself is the project root.

The resolver tries them in that order and returns the first match.
When none match the resolver exits 2 with the structured error
``gate misconfigured: cannot resolve preflight_implementation.py at
any expected path -- run `task framework:doctor` for diagnostics`` so
the wrapping Taskfile target propagates the non-zero exit instead of
silently invoking ``uv run python <missing>`` and letting the gate's
failure shape leak through to the agent.

Mirrors the shape of ``scripts/resolve_version.py`` (#723): pure
stdlib, ``main(argv) -> int``, a public Python API
(``resolve_preflight_path(project_root)``) for tests and future
callers, and a CLI for the Taskfile body.

Refs:
- #1046 (cohort)
- #1047 (absorbed by PR-C)
- #810 (the gate this resolver wraps)
- #992 (the install layout flip that made the legacy hardcoded path stale)
- #1054 (PR-A canonical-path enforcement)
- #1057 (PR-B framework:doctor + manifest + v3 sentinel)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

#: Candidate subpaths probed under the supplied project root, in
#: priority order. The first existing file wins. Each entry is a tuple
#: of path parts so :func:`pathlib.Path.joinpath` reconstructs the
#: location with native separators on every platform.
CANDIDATE_SUBPATHS: tuple[tuple[str, ...], ...] = (
    (".deft", "core", "scripts", "preflight_implementation.py"),
    ("deft", "scripts", "preflight_implementation.py"),
    ("scripts", "preflight_implementation.py"),
)

#: Structured fail-closed error message. Names the failure class
#: (``gate misconfigured``) so operators (and downstream parsers) can
#: classify the exit without parsing free-form text, enumerates the
#: probed layouts so a misconfigured install surfaces the expected
#: locations, and points at ``task framework:doctor`` (the PR-B
#: install-integrity probe from #1057) for the diagnostic surface.
FAIL_CLOSED_MESSAGE = (
    "gate misconfigured: cannot resolve preflight_implementation.py "
    "at any expected path (.deft/core/scripts/, deft/scripts/, scripts/) "
    "under project root {project_root} -- "
    "run `task framework:doctor` for diagnostics."
)


def resolve_preflight_path(project_root: Path | str) -> Path | None:
    """Probe the candidate subpaths under ``project_root``.

    Returns the absolute resolved path of the first existing
    ``preflight_implementation.py``, or ``None`` if no candidate
    resolves. Pure function -- no I/O beyond ``Path.is_file()``.

    The project root is resolved to an absolute path first so callers
    that pass a relative path (e.g. ``"."`` from a Taskfile target
    invoked under ``USER_WORKING_DIR``) get a stable absolute result.
    """
    root = Path(project_root).resolve()
    for parts in CANDIDATE_SUBPATHS:
        candidate = root.joinpath(*parts)
        if candidate.is_file():
            return candidate
    return None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="_resolve_preflight_path.py",
        description=(
            "Resolve preflight_implementation.py under the supplied "
            "project root (#1046 PR-C / #1047). Probes the v0.27+ "
            "canonical install layout (.deft/core/scripts/), the "
            "legacy install layout (deft/scripts/), and the in-repo "
            "case (scripts/) in that order. Prints the resolved "
            "absolute path on stdout, or exits 2 with a structured "
            "fail-closed error message naming the failure class and "
            "pointing at `task framework:doctor`."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help=(
            "Project root to probe. Defaults to the current working "
            "directory so `task vbrief:preflight` can pass "
            "{{.USER_WORKING_DIR}} through unchanged."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root)
    resolved = resolve_preflight_path(project_root)
    if resolved is None:
        print(
            FAIL_CLOSED_MESSAGE.format(project_root=project_root.resolve()),
            file=sys.stderr,
        )
        return 2
    # Print the resolved path on stdout WITHOUT a trailing newline so
    # the Taskfile body can capture it via $(...) without trimming
    # whitespace -- matches the convention from scripts/resolve_version.py
    # which also uses raw stdout writes for the same reason.
    sys.stdout.write(str(resolved))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
