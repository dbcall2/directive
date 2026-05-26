"""Shared pre-v0.20 document-model detection helpers.

The session-start guard, CLI gate, validator, and migration preflight all need
the same distinction:

* deprecation redirect stubs are migrated/current enough;
* generated ``SPECIFICATION.md`` exports from ``task spec:render`` are current
  vBRIEF artifacts when their source JSON and lifecycle folders exist;
* hand-authored root docs are legacy pre-cutover inputs.
"""

from __future__ import annotations

from pathlib import Path

LIFECYCLE_FOLDERS: tuple[str, ...] = (
    "proposed",
    "pending",
    "active",
    "completed",
    "cancelled",
)

DEPRECATED_REDIRECT_SENTINEL = "<!-- deft:deprecated-redirect -->"
DEPRECATION_REDIRECT_PURPOSE = "<!-- Purpose: deprecation redirect -->"

GENERATED_SPEC_PURPOSE = "<!-- Purpose: rendered specification -->"
GENERATED_SPEC_SOURCE = "<!-- Source of truth: vbrief/specification.vbrief.json -->"
SPEC_SOURCE_RELPATH = Path("vbrief") / "specification.vbrief.json"


def missing_lifecycle_folders(project_root: Path) -> list[str]:
    """Return missing vBRIEF lifecycle folder names for ``project_root``."""
    vbrief_root = project_root / "vbrief"
    return [folder for folder in LIFECYCLE_FOLDERS if not (vbrief_root / folder).is_dir()]


def has_complete_lifecycle(project_root: Path) -> bool:
    """Return True when every canonical lifecycle folder exists."""
    return not missing_lifecycle_folders(project_root)


def is_deprecation_redirect(content: str) -> bool:
    """Return True when markdown content is a migration redirect stub."""
    return DEPRECATED_REDIRECT_SENTINEL in content or DEPRECATION_REDIRECT_PURPOSE in content


def is_current_generated_specification(project_root: Path, content: str) -> bool:
    """Return True for a current ``task spec:render`` root export.

    The banner alone is not enough: the export is current only when the
    declared vBRIEF source exists and the lifecycle folders are present.
    """
    return (
        GENERATED_SPEC_PURPOSE in content
        and GENERATED_SPEC_SOURCE in content
        and (project_root / SPEC_SOURCE_RELPATH).is_file()
        and has_complete_lifecycle(project_root)
    )


def root_markdown_is_legacy(project_root: Path, filename: str, content: str) -> bool:
    """Return True if a root markdown artifact should trigger migration."""
    if is_deprecation_redirect(content):
        return False
    if filename == "SPECIFICATION.md" and is_current_generated_specification(project_root, content):
        return False
    return filename in {"SPECIFICATION.md", "PROJECT.md"}


def detect_pre_cutover_legacy(project_root: Path) -> list[str]:
    """Return root artifact filenames that are legacy pre-v0.20 inputs."""
    legacy: list[str] = []
    for filename in ("SPECIFICATION.md", "PROJECT.md"):
        candidate = project_root / filename
        if not candidate.is_file():
            continue
        try:
            content = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if root_markdown_is_legacy(project_root, filename, content):
            legacy.append(filename)
    return legacy
