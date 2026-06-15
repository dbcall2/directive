"""Resolve the consumer Taskfile namespace for Deft task re-entry.

Consumer projects include the framework Taskfile under a namespace such as
``deft:``. Python helpers that must re-enter ``task`` need that outer include
key, but nested Taskfile fragments only see their local task names via
``{{.TASK}}``. This module keeps the namespace discovery in one stdlib-only
place so verifier/session surfaces do not guess differently.
"""

from __future__ import annotations

import os
from pathlib import Path

TASK_PREFIX_ENV_VAR = "DEFT_TASK_PREFIX"
TASKFILE_NAMES: tuple[str, ...] = ("Taskfile.yml", "Taskfile.yaml")


def normalize_task_prefix(task_prefix: str | None) -> str:
    """Return ``task_prefix`` as ``""`` or a colon-terminated namespace."""
    prefix = (task_prefix or "").strip()
    if not prefix:
        return ""
    return prefix if prefix.endswith(":") else f"{prefix}:"


def resolve_task_prefix(
    project_root: Path,
    *,
    framework_root: Path,
    explicit: str | None = None,
    env_var: str = TASK_PREFIX_ENV_VAR,
) -> str:
    """Resolve the namespace prefix for framework tasks in ``project_root``.

    Resolution order is explicit argument, environment variable, then discovery
    from the root Taskfile include that targets ``framework_root``. Empty values
    are treated as absent so callers can pass argparse defaults without
    disabling discovery.
    """
    explicit_prefix = normalize_task_prefix(explicit)
    if explicit_prefix:
        return explicit_prefix

    env_prefix = normalize_task_prefix(os.environ.get(env_var))
    if env_prefix:
        return env_prefix

    return discover_task_prefix(project_root, framework_root=framework_root)


def discover_task_prefix(project_root: Path, *, framework_root: Path) -> str:
    """Return the include namespace pointing at ``framework_root``, if any."""
    root = Path(project_root)
    for name in TASKFILE_NAMES:
        taskfile = root / name
        if not taskfile.is_file():
            continue
        discovered = _discover_task_prefix_from_taskfile(taskfile, framework_root)
        if discovered:
            return discovered
    return ""


def _discover_task_prefix_from_taskfile(taskfile: Path, framework_root: Path) -> str:
    """Parse the small subset of go-task include YAML needed for discovery."""
    try:
        lines = taskfile.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return ""

    includes_indent: int | None = None
    current_key: str | None = None
    current_key_indent: int | None = None
    project_root = taskfile.parent

    for raw_line in lines:
        line = _strip_inline_comment(raw_line).rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()

        if includes_indent is None:
            if stripped == "includes:":
                includes_indent = indent
            continue

        if indent <= includes_indent:
            break

        if current_key_indent is None or indent <= current_key_indent:
            current_key = None
            current_key_indent = None
            if ":" not in stripped:
                continue
            raw_key, raw_value = stripped.split(":", 1)
            key = _strip_quotes(raw_key.strip())
            value = raw_value.strip()
            if not key:
                continue
            if value and _include_value_matches(value, project_root, framework_root):
                return normalize_task_prefix(key)
            current_key = key
            current_key_indent = indent
            continue

        if current_key and stripped.startswith("taskfile:"):
            value = stripped.split(":", 1)[1].strip()
            if _include_value_matches(value, project_root, framework_root):
                return normalize_task_prefix(current_key)

    return ""


def _include_value_matches(value: str, project_root: Path, framework_root: Path) -> bool:
    raw_path = _strip_quotes(value.strip())
    if not raw_path or raw_path.startswith("{"):
        return False
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = project_root / candidate
    return _candidate_matches_framework(candidate, framework_root)


def _candidate_matches_framework(candidate: Path, framework_root: Path) -> bool:
    framework_root = framework_root.resolve()
    framework_taskfiles = {framework_root / name for name in TASKFILE_NAMES}
    candidate_resolved = candidate.resolve(strict=False)
    if candidate_resolved in framework_taskfiles:
        return True
    if candidate_resolved == framework_root:
        return True
    return any(
        (candidate / name).resolve(strict=False) in framework_taskfiles
        for name in TASKFILE_NAMES
    )


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _strip_inline_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if quote == '"' and char == "\\":
            escaped = True
            continue
        if char in {"'", '"'}:
            quote = None if quote == char else char if quote is None else quote
            continue
        if char == "#" and quote is None:
            return line[:index]
    return line
