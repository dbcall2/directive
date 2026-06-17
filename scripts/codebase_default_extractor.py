#!/usr/bin/env python3
"""Dependency-free default extractor for #1595 codebase-map artifacts.

The default path is intentionally modest: it walks the repository, applies the
authored ``codeStructure`` module globs when available, and uses import-line
heuristics for coarse coupling. It does not parse ASTs, call the network, or
ask a model to summarize code. Richer providers can replace this artifact via
``scripts/codebase_provider.py`` once they satisfy the provider contract.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import code_structure_validate
from codebase_projection_registry import (
    CODEBASE_MAP_FORMAT_VERSION,
    CODEBASE_MAP_KIND,
    CODEBASE_PROVIDER_CONTRACT_VERSION,
)

DEFAULT_PROVIDER_NAME = "directive-default-extractor"
DEFAULT_PROVIDER_VERSION = "0.1"
MAX_IMPORT_SCAN_BYTES = 262_144
MAX_FILES_PER_MODULE = 100
MAX_EVIDENCE_PER_EDGE = 5

SKIP_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "swarm-worktrees",
}

LANGUAGE_BY_SUFFIX = {
    ".go": "Go",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".json": "JSON",
    ".md": "Markdown",
    ".py": "Python",
    ".sh": "Shell",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".yaml": "YAML",
    ".yml": "YAML",
}

ENTRYPOINT_NAMES = {
    "__main__.py",
    "cli.py",
    "cmd.py",
    "index.js",
    "index.ts",
    "main.go",
    "main.py",
    "run",
    "run.py",
}

IMPORT_PATTERNS = [
    re.compile(r"^\s*import\s+([A-Za-z_][\w.]*)"),
    re.compile(r"^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+"),
    re.compile(r"^\s*import\s+.*?\s+from\s+[\"']([^\"']+)[\"']"),
    re.compile(r"^\s*(?:const|let|var)\s+.*?=\s*require\([\"']([^\"']+)[\"']\)"),
    re.compile(r"^\s*import\s+[\"']([^\"']+)[\"']"),
]


def _posix(path: Path) -> str:
    return path.as_posix()


def _relative_file(path: Path, project_root: Path) -> str:
    return _posix(path.relative_to(project_root))


def default_code_structure_path(project_root: Path, code_structure_path: Path | None) -> Path:
    """Return the authored codeStructure source path used by the default extractor."""
    return code_structure_path or project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"


def _stable_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "root"


def _repo_files(project_root: Path) -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(project_root):
        dirnames[:] = [dirname for dirname in dirnames if dirname not in SKIP_DIRS]
        for filename in filenames:
            files.append(Path(dirpath) / filename)
    return sorted(files, key=lambda item: _relative_file(item, project_root))


def _glob_files(project_root: Path, globs: list[str]) -> list[Path]:
    files: dict[str, Path] = {}
    for glob_value in globs:
        for match in project_root.glob(glob_value):
            if not match.is_file():
                continue
            rel_parts = match.relative_to(project_root).parts
            if any(part in SKIP_DIRS for part in rel_parts):
                continue
            files[_relative_file(match, project_root)] = match
    return [files[key] for key in sorted(files)]


def _load_authored_code_structure(
    project_root: Path, code_structure_path: Path | None
) -> tuple[dict[str, Any] | None, str | None]:
    path = default_code_structure_path(project_root, code_structure_path)
    if not path.exists():
        return None, None
    data = code_structure_validate.load_json_file(path)
    extracted = code_structure_validate.extract_code_structure(data)
    if extracted is None:
        return None, None
    return extracted.record, extracted.home


def _module_prefixes(module: dict[str, Any], files: list[Path], project_root: Path) -> set[str]:
    prefixes: set[str] = set()
    for glob_value in module.get("pathGlobs", []):
        if not isinstance(glob_value, str):
            continue
        first = glob_value.split("/", maxsplit=1)[0]
        if (
            first
            and not code_structure_validate._has_glob_magic(first)
            and first not in {".", "**"}
        ):
            prefixes.add(first.removesuffix(".py"))
    for file_path in files:
        rel_parts = file_path.relative_to(project_root).parts
        if len(rel_parts) > 1:
            prefixes.add(rel_parts[0])
        elif file_path.suffix == ".py":
            prefixes.add(file_path.stem)
    return {prefix for prefix in prefixes if prefix}


def _curated_modules(
    project_root: Path, code_structure: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, set[str]], list[dict[str, str]]]:
    artifacts: list[dict[str, Any]] = []
    file_to_module: dict[str, str] = {}
    prefixes_by_module: dict[str, set[str]] = {}
    degraded: list[dict[str, str]] = []

    for raw_module in code_structure.get("modules", []):
        if not isinstance(raw_module, dict):
            continue
        module_id = str(raw_module.get("id", "unknown"))
        globs = [value for value in raw_module.get("pathGlobs", []) if isinstance(value, str)]
        files = _glob_files(project_root, globs)
        rel_files = [_relative_file(path, project_root) for path in files]
        for rel_path in rel_files:
            file_to_module.setdefault(rel_path, module_id)
        if len(rel_files) > MAX_FILES_PER_MODULE:
            degraded.append(
                {
                    "code": "MODULE-FILES-TRUNCATED",
                    "module": module_id,
                    "message": (
                        f"Module file list was truncated to {MAX_FILES_PER_MODULE} "
                        "deterministic entries."
                    ),
                }
            )
        artifacts.append(
            {
                "id": module_id,
                "name": raw_module.get("name"),
                "purpose": raw_module.get("purpose"),
                "pathGlobs": globs,
                "fileCount": len(rel_files),
                "files": rel_files[:MAX_FILES_PER_MODULE],
                "derivedFrom": {
                    "intent": "codeStructure.modules[]",
                    "files": "repository-glob-walk",
                },
            }
        )
        prefixes_by_module[module_id] = _module_prefixes(raw_module, files, project_root)
    return artifacts, file_to_module, prefixes_by_module, degraded


def _directory_modules(
    project_root: Path,
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, set[str]], list[dict[str, str]]]:
    grouped: dict[str, list[Path]] = defaultdict(list)
    for file_path in _repo_files(project_root):
        parts = file_path.relative_to(project_root).parts
        if not parts:
            continue
        top = parts[0] if len(parts) > 1 else "root-files"
        grouped[top].append(file_path)

    modules: list[dict[str, Any]] = []
    file_to_module: dict[str, str] = {}
    prefixes_by_module: dict[str, set[str]] = {}
    degraded_markers: list[dict[str, str]] = [
        {
            "code": "NO-CODESTRUCTURE",
            "message": (
                "No authored codeStructure metadata was found; modules were derived from "
                "top-level repository paths."
            ),
        }
    ]
    for top in sorted(grouped):
        module_id = _stable_id(top)
        rel_files = [_relative_file(path, project_root) for path in sorted(grouped[top])]
        for rel_path in rel_files:
            file_to_module.setdefault(rel_path, module_id)
        if len(rel_files) > MAX_FILES_PER_MODULE:
            degraded_markers.append(
                {
                    "code": "MODULE-FILES-TRUNCATED",
                    "module": module_id,
                    "message": (
                        f"Module file list was truncated to {MAX_FILES_PER_MODULE} "
                        "deterministic entries."
                    ),
                }
            )
        modules.append(
            {
                "id": module_id,
                "name": top,
                "purpose": None,
                "pathGlobs": [f"{top}/**/*" if top != "root-files" else "*"],
                "fileCount": len(rel_files),
                "files": rel_files[:MAX_FILES_PER_MODULE],
                "derivedFrom": {
                    "intent": "directory-derived-fallback",
                    "files": "repository-tree-walk",
                },
            }
        )
        prefixes_by_module[module_id] = {top} if top != "root-files" else set()

    return modules, file_to_module, prefixes_by_module, degraded_markers


def _read_imports(path: Path) -> list[tuple[int, str]]:
    if path.suffix not in {".go", ".js", ".jsx", ".py", ".ts", ".tsx"}:
        return []
    try:
        if path.stat().st_size > MAX_IMPORT_SCAN_BYTES:
            return []
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []

    imports: list[tuple[int, str]] = []
    in_go_import_block = False
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if path.suffix == ".go":
            if stripped == "import (":
                in_go_import_block = True
                continue
            if in_go_import_block and stripped == ")":
                in_go_import_block = False
                continue
            if in_go_import_block:
                match = re.search(r'"([^"]+)"', stripped)
                if match:
                    imports.append((line_number, match.group(1)))
                continue
            match = re.match(r'^\s*import\s+"([^"]+)"', line)
            if match:
                imports.append((line_number, match.group(1)))
            continue

        for pattern in IMPORT_PATTERNS:
            match = pattern.match(line)
            if match:
                imports.append((line_number, match.group(1)))
                break
    return imports


def _import_targets(ref: str, prefixes_by_module: dict[str, set[str]]) -> set[str]:
    if ref.startswith("."):
        return set()
    normalized = ref.removeprefix("@")
    first_segment = re.split(r"[/.]", normalized, maxsplit=1)[0]
    targets: set[str] = set()
    for module_id, prefixes in prefixes_by_module.items():
        if first_segment in prefixes or ref in prefixes:
            targets.add(module_id)
    return targets


def _coupling_edges(
    project_root: Path, file_to_module: dict[str, str], prefixes_by_module: dict[str, set[str]]
) -> list[dict[str, Any]]:
    edges: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for rel_path, source_module in sorted(file_to_module.items()):
        path = project_root / rel_path
        for line_number, import_ref in _read_imports(path):
            for target_module in _import_targets(import_ref, prefixes_by_module):
                if target_module == source_module:
                    continue
                evidence = edges[(source_module, target_module)]
                if len(evidence) < MAX_EVIDENCE_PER_EDGE:
                    evidence.append(
                        {"path": rel_path, "line": line_number, "import": import_ref}
                    )

    return [
        {
            "from": source,
            "to": target,
            "derivedFrom": "import-line-heuristic",
            "confidence": "heuristic",
            "evidence": evidence,
        }
        for (source, target), evidence in sorted(edges.items())
    ]


def _entry_points(file_to_module: dict[str, str]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for rel_path, module_id in sorted(file_to_module.items()):
        path = Path(rel_path)
        if path.name in ENTRYPOINT_NAMES or path.parts[:1] == ("cmd",):
            entries.append(
                {
                    "path": rel_path,
                    "module": module_id,
                    "derivedFrom": "filename-heuristic",
                    "confidence": "heuristic",
                }
            )
    return entries


def _language_distribution(file_to_module: dict[str, str]) -> list[dict[str, Any]]:
    counts = Counter(
        LANGUAGE_BY_SUFFIX.get(Path(rel_path).suffix, "Other") for rel_path in file_to_module
    )
    return [
        {"language": language, "files": count, "derivedFrom": "extension-heuristic"}
        for language, count in sorted(counts.items())
    ]


def build_codebase_map(
    project_root: Path,
    *,
    code_structure_path: Path | None = None,
    fallback_reason: str | None = None,
) -> dict[str, Any]:
    """Build a deterministic tier-1 codebase-map artifact."""
    project_root = project_root.resolve()
    code_structure, source_home = _load_authored_code_structure(project_root, code_structure_path)
    source_path = default_code_structure_path(project_root, code_structure_path)

    if code_structure is not None:
        modules, file_to_module, prefixes_by_module, degraded = _curated_modules(
            project_root, code_structure
        )
    else:
        modules, file_to_module, prefixes_by_module, degraded = _directory_modules(project_root)

    degraded.append(
        {
            "code": "AST-FREE-HEURISTICS",
            "message": (
                "Default extractor uses repository walking and import-line heuristics only; "
                "no AST or language parser provider was configured."
            ),
        }
    )
    if fallback_reason:
        degraded.append({"code": "PROVIDER-FALLBACK", "message": fallback_reason})

    return {
        "formatVersion": CODEBASE_MAP_FORMAT_VERSION,
        "contractVersion": CODEBASE_PROVIDER_CONTRACT_VERSION,
        "kind": CODEBASE_MAP_KIND,
        "provider": {
            "name": DEFAULT_PROVIDER_NAME,
            "version": DEFAULT_PROVIDER_VERSION,
            "mode": "default",
            "degraded": True,
            **({"fallbackReason": fallback_reason} if fallback_reason else {}),
        },
        "source": {
            "projectRoot": str(project_root),
            "codeStructurePath": str(source_path),
            "codeStructureHome": source_home,
        },
        "modules": modules,
        "coupling": _coupling_edges(project_root, file_to_module, prefixes_by_module),
        "entryPoints": _entry_points(file_to_module),
        "languageDistribution": _language_distribution(file_to_module),
        "degraded": degraded,
    }


def config_error_to_dict(
    path: Path, error: code_structure_validate.CodeStructureConfigError
) -> dict[str, Any]:
    """Return the structured config-error shape shared by codebase CLIs."""
    return {
        "path": str(path),
        "ok": False,
        "errors": [{"code": "CS-CONFIG", "message": str(error), "location": str(path)}],
        "warnings": [],
    }


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Emit the default codebase-map artifact.")
    parser.add_argument("--project-root", default=".", help="Repository root to inspect.")
    parser.add_argument("--path", help="Explicit vBRIEF containing codeStructure metadata.")
    args = parser.parse_args(argv)

    project_root = Path(args.project_root)
    code_structure_path = Path(args.path) if args.path else None
    try:
        artifact = build_codebase_map(project_root, code_structure_path=code_structure_path)
    except code_structure_validate.CodeStructureConfigError as exc:
        print(
            json.dumps(
                config_error_to_dict(
                    default_code_structure_path(project_root, code_structure_path), exc
                ),
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
