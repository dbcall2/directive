#!/usr/bin/env python3
"""code_structure_validate.py -- validate #1595 codeStructure metadata.

The PR2 profile keeps authored codebase-structure intent in a git-tracked
vBRIEF record while generated maps, indexes, and headers remain projections.
This validator is intentionally small and deterministic: it validates the
shape and cross-references of the authored ``codeStructure`` record without
attempting extraction or MAP generation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

STABLE_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
CODE_STRUCTURE_VERSION = "0.1"
DIRECTIVE_HOME = "x-directive/architecture.codeStructure"
PLAN_HOME = "plan.architecture.codeStructure"


class CodeStructureConfigError(RuntimeError):
    """Raised when a file cannot be loaded as a JSON object."""


@dataclass(frozen=True)
class Finding:
    """One deterministic validation finding."""

    code: str
    message: str
    location: str


@dataclass(frozen=True)
class ValidationResult:
    """Validation result for one codeStructure record."""

    errors: list[Finding]

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass(frozen=True)
class ExtractedCodeStructure:
    """A codeStructure record plus the home it was read from."""

    record: dict[str, Any]
    home: str


def _finding(code: str, message: str, location: str) -> Finding:
    return Finding(code=code, message=message, location=location)


def _is_stable_id(value: object) -> bool:
    return isinstance(value, str) and bool(STABLE_ID_RE.fullmatch(value))


def _non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_relative_path(value: object) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "\\" in text or text.startswith(("~", "$")):
        return False
    # Reject POSIX absolute paths and Windows drive-ish paths while keeping
    # repository-relative dot directories such as .planning/.
    if PurePosixPath(text).is_absolute() or re.match(r"^[A-Za-z]:", text):
        return False
    parts = PurePosixPath(text).parts
    return ".." not in parts


def extract_code_structure(data: dict[str, Any]) -> ExtractedCodeStructure | None:
    """Return a codeStructure record from the canonical or legacy PR2 homes."""
    extension = data.get("x-directive/architecture")
    if isinstance(extension, dict):
        record = extension.get("codeStructure")
        if isinstance(record, dict):
            return ExtractedCodeStructure(record=record, home=DIRECTIVE_HOME)

    plan = data.get("plan")
    if isinstance(plan, dict):
        architecture = plan.get("architecture")
        if isinstance(architecture, dict):
            record = architecture.get("codeStructure")
            if isinstance(record, dict):
                return ExtractedCodeStructure(record=record, home=PLAN_HOME)

    return None


def _validate_required_arrays(record: dict[str, Any], errors: list[Finding], source: str) -> None:
    if record.get("version") != CODE_STRUCTURE_VERSION:
        errors.append(
            _finding(
                "CS-VERSION",
                f"codeStructure.version must be {CODE_STRUCTURE_VERSION!r}",
                source,
            )
        )
    for key in ("modules", "pathOwnership", "allowedPatterns", "projectionManifest"):
        if not isinstance(record.get(key), list):
            errors.append(_finding("CS-SHAPE", f"codeStructure.{key} must be an array", source))
    if isinstance(record.get("modules"), list) and not record["modules"]:
        errors.append(
            _finding("CS-MODULES", "codeStructure.modules must contain at least one module", source)
        )


def _validate_module(
    module: object,
    index: int,
    errors: list[Finding],
    glob_owner: dict[str, str],
) -> str | None:
    location = f"modules[{index}]"
    if not isinstance(module, dict):
        errors.append(_finding("CS-MODULE", "module entry must be an object", location))
        return None

    module_id = module.get("id")
    if not _is_stable_id(module_id):
        errors.append(
            _finding(
                "CS-MODULE-ID",
                "module id must be a stable lowercase kebab-case id",
                f"{location}.id",
            )
        )
        return None

    for key in ("name", "purpose"):
        if not _non_empty_string(module.get(key)):
            errors.append(
                _finding("CS-MODULE", f"module {module_id!r} needs non-empty {key}", location)
            )

    globs = module.get("pathGlobs")
    if not isinstance(globs, list) or not globs:
        errors.append(
            _finding(
                "CS-GLOB",
                f"module {module_id!r} needs at least one pathGlob",
                f"{location}.pathGlobs",
            )
        )
        return str(module_id)

    for glob_index, glob_value in enumerate(globs):
        glob_location = f"{location}.pathGlobs[{glob_index}]"
        if not _safe_relative_path(glob_value):
            errors.append(
                _finding(
                    "CS-GLOB",
                    f"module {module_id!r} pathGlob must be repository-relative",
                    glob_location,
                )
            )
            continue
        prior = glob_owner.get(str(glob_value))
        if prior is not None and prior != module_id:
            errors.append(
                _finding(
                    "CS-GLOB-CONFLICT",
                    f"pathGlob {glob_value!r} is assigned to both {prior!r} and {module_id!r}",
                    glob_location,
                )
            )
        else:
            glob_owner[str(glob_value)] = str(module_id)

    return str(module_id)


def _validate_module_ref(
    module_id: object,
    module_ids: set[str],
    location: str,
    errors: list[Finding],
) -> None:
    if not isinstance(module_id, str) or module_id not in module_ids:
        errors.append(
            _finding(
                "CS-MODULE-REF",
                f"module reference {module_id!r} does not match a declared module id",
                location,
            )
        )


def _validate_path_ownership(
    entries: list[Any],
    module_ids: set[str],
    errors: list[Finding],
) -> None:
    ownership: dict[str, str] = {}
    for index, entry in enumerate(entries):
        location = f"pathOwnership[{index}]"
        if not isinstance(entry, dict):
            errors.append(
                _finding("CS-OWNERSHIP", "pathOwnership entry must be an object", location)
            )
            continue
        glob_value = entry.get("pathGlob")
        if not _safe_relative_path(glob_value):
            errors.append(
                _finding("CS-GLOB", "pathOwnership.pathGlob must be repository-relative", location)
            )
        module_id = entry.get("module")
        _validate_module_ref(module_id, module_ids, f"{location}.module", errors)
        if isinstance(glob_value, str) and isinstance(module_id, str):
            prior = ownership.get(glob_value)
            if prior is not None and prior != module_id:
                errors.append(
                    _finding(
                        "CS-OWNERSHIP-CONFLICT",
                        f"pathOwnership {glob_value!r} points at both {prior!r} and {module_id!r}",
                        location,
                    )
                )
            else:
                ownership[glob_value] = module_id


def _validate_allowed_patterns(
    entries: list[Any],
    module_ids: set[str],
    errors: list[Finding],
) -> None:
    seen_ids: set[str] = set()
    for index, entry in enumerate(entries):
        location = f"allowedPatterns[{index}]"
        if not isinstance(entry, dict):
            errors.append(
                _finding("CS-PATTERN", "allowedPatterns entry must be an object", location)
            )
            continue
        pattern_id = entry.get("id")
        if not _is_stable_id(pattern_id):
            errors.append(
                _finding("CS-PATTERN-ID", "allowed pattern id must be stable kebab-case", location)
            )
        elif pattern_id in seen_ids:
            errors.append(
                _finding("CS-PATTERN-ID", f"duplicate allowed pattern id {pattern_id!r}", location)
            )
        else:
            seen_ids.add(str(pattern_id))
        _validate_module_ref(entry.get("module"), module_ids, f"{location}.module", errors)
        for key in ("name", "description"):
            if not _non_empty_string(entry.get(key)):
                errors.append(_finding("CS-PATTERN", f"allowed pattern needs {key}", location))
        applies_to = entry.get("appliesTo")
        if applies_to is None:
            continue
        if not isinstance(applies_to, list):
            errors.append(
                _finding("CS-PATTERN", "allowed pattern appliesTo must be an array", location)
            )
            continue
        for path_index, path_value in enumerate(applies_to):
            if not _safe_relative_path(path_value):
                errors.append(
                    _finding(
                        "CS-PATH",
                        "allowed pattern appliesTo path must be repository-relative",
                        f"{location}.appliesTo[{path_index}]",
                    )
                )


def _validate_projection_manifest(entries: list[Any], errors: list[Finding]) -> None:
    seen_paths: set[str] = set()
    for index, entry in enumerate(entries):
        location = f"projectionManifest[{index}]"
        if not isinstance(entry, dict):
            errors.append(
                _finding("CS-PROJECTION", "projectionManifest entry must be an object", location)
            )
            continue
        path_value = entry.get("path")
        if not _safe_relative_path(path_value):
            errors.append(
                _finding("CS-PATH", "projection path must be repository-relative", location)
            )
        elif str(path_value) in seen_paths:
            errors.append(
                _finding("CS-PROJECTION", f"duplicate projection path {path_value!r}", location)
            )
        else:
            seen_paths.add(str(path_value))
        if not _is_stable_id(entry.get("kind")):
            errors.append(
                _finding("CS-PROJECTION", "projection kind must be stable kebab-case", location)
            )
        if not _non_empty_string(entry.get("source")):
            errors.append(
                _finding("CS-PROJECTION", "projection source must be non-empty", location)
            )
        if not isinstance(entry.get("generated"), bool):
            errors.append(
                _finding("CS-PROJECTION", "projection generated must be boolean", location)
            )


def _validate_file_purpose_overrides(
    entries: object,
    module_ids: set[str],
    errors: list[Finding],
) -> None:
    if entries is None:
        return
    if not isinstance(entries, list):
        errors.append(
            _finding(
                "CS-FILE-OVERRIDE", "filePurposeOverrides must be an array", "filePurposeOverrides"
            )
        )
        return
    seen_paths: set[str] = set()
    for index, entry in enumerate(entries):
        location = f"filePurposeOverrides[{index}]"
        if not isinstance(entry, dict):
            errors.append(_finding("CS-FILE-OVERRIDE", "file override must be an object", location))
            continue
        path_value = entry.get("path")
        if not _safe_relative_path(path_value):
            errors.append(
                _finding("CS-PATH", "file override path must be repository-relative", location)
            )
        elif str(path_value) in seen_paths:
            errors.append(
                _finding("CS-FILE-OVERRIDE", f"duplicate override path {path_value!r}", location)
            )
        else:
            seen_paths.add(str(path_value))
        if not _non_empty_string(entry.get("purpose")):
            errors.append(_finding("CS-FILE-OVERRIDE", "file override needs purpose", location))
        if "module" in entry:
            _validate_module_ref(entry.get("module"), module_ids, f"{location}.module", errors)


def _validate_glossary_refs(entries: object, errors: list[Finding]) -> None:
    if entries is None:
        return
    if not isinstance(entries, list):
        errors.append(_finding("CS-GLOSSARY", "glossaryRefs must be an array", "glossaryRefs"))
        return
    for index, entry in enumerate(entries):
        location = f"glossaryRefs[{index}]"
        if not isinstance(entry, dict):
            errors.append(_finding("CS-GLOSSARY", "glossary ref must be an object", location))
            continue
        if not _non_empty_string(entry.get("term")):
            errors.append(_finding("CS-GLOSSARY", "glossary ref needs term", location))
        if "uri" in entry and not _safe_relative_path(entry.get("uri")):
            errors.append(
                _finding("CS-PATH", "glossary ref uri must be repository-relative", location)
            )


def validate_code_structure(record: dict[str, Any], source: str = "<memory>") -> ValidationResult:
    """Validate one codeStructure record."""
    errors: list[Finding] = []
    _validate_required_arrays(record, errors, source)

    glob_owner: dict[str, str] = {}
    module_ids: set[str] = set()
    for index, module in enumerate(_as_list(record.get("modules"))):
        module_id = _validate_module(module, index, errors, glob_owner)
        if module_id is None:
            continue
        if module_id in module_ids:
            errors.append(
                _finding(
                    "CS-MODULE-ID", f"duplicate module id {module_id!r}", f"modules[{index}].id"
                )
            )
        module_ids.add(module_id)

    _validate_path_ownership(_as_list(record.get("pathOwnership")), module_ids, errors)
    _validate_allowed_patterns(_as_list(record.get("allowedPatterns")), module_ids, errors)
    _validate_projection_manifest(_as_list(record.get("projectionManifest")), errors)
    _validate_file_purpose_overrides(record.get("filePurposeOverrides"), module_ids, errors)
    _validate_glossary_refs(record.get("glossaryRefs"), errors)
    return ValidationResult(errors=errors)


def load_json_file(path: Path) -> dict[str, Any]:
    """Load a JSON object from *path*."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CodeStructureConfigError(f"codeStructure file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CodeStructureConfigError(
            f"{path} is not valid JSON: {exc.msg} (line {exc.lineno})"
        ) from exc
    if not isinstance(data, dict):
        raise CodeStructureConfigError(f"{path} top-level value must be an object")
    return data


def validate_file(path: Path) -> ValidationResult:
    """Load and validate the codeStructure record in *path*."""
    data = load_json_file(path)
    extracted = extract_code_structure(data)
    if extracted is None:
        return ValidationResult(
            errors=[
                _finding(
                    "CS-MISSING",
                    f"no {PLAN_HOME} or {DIRECTIVE_HOME} record found",
                    str(path),
                )
            ]
        )
    return validate_code_structure(extracted.record, source=f"{path}:{extracted.home}")


def discover_code_structure_paths(project_root: Path) -> list[Path]:
    """Discover codeStructure-bearing vBRIEFs for a project root."""
    paths: list[Path] = []
    architecture_dir = project_root / "vbrief" / "architecture"
    if architecture_dir.is_dir():
        paths.extend(sorted(architecture_dir.glob("*.vbrief.json")))

    project_def = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    if project_def.exists():
        try:
            data = load_json_file(project_def)
        except CodeStructureConfigError:
            paths.append(project_def)
        else:
            if extract_code_structure(data) is not None:
                paths.append(project_def)
    return paths


def _result_to_dict(path: Path, result: ValidationResult) -> dict[str, Any]:
    return {
        "path": str(path),
        "ok": result.ok,
        "errors": [
            {"code": finding.code, "message": finding.message, "location": finding.location}
            for finding in result.errors
        ],
    }


def _config_error_to_dict(path: Path, error: CodeStructureConfigError) -> dict[str, Any]:
    return {
        "path": str(path),
        "ok": False,
        "errors": [{"code": "CS-CONFIG", "message": str(error), "location": str(path)}],
    }


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Validate codeStructure metadata.")
    parser.add_argument("--project-root", default=".", help="Project root for default discovery.")
    parser.add_argument("--path", action="append", help="Explicit codeStructure vBRIEF path.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON summary.")
    args = parser.parse_args(argv)

    project_root = Path(args.project_root)
    paths = (
        [Path(p) for p in args.path] if args.path else discover_code_structure_paths(project_root)
    )

    if not paths:
        if args.json:
            print(json.dumps({"ok": True, "validated": []}, indent=2))
        else:
            print("OK: no codeStructure metadata found")
        return 0

    summaries: list[dict[str, Any]] = []
    exit_code = 0
    for path in paths:
        try:
            result = validate_file(path)
        except CodeStructureConfigError as exc:
            summaries.append(_config_error_to_dict(path, exc))
            exit_code = 2
            continue
        summaries.append(_result_to_dict(path, result))
        if not result.ok and exit_code == 0:
            exit_code = 1

    if args.json:
        print(json.dumps({"ok": exit_code == 0, "validated": summaries}, indent=2))
    else:
        for summary in summaries:
            path = summary["path"]
            if summary["ok"]:
                print(f"OK: {path}")
                continue
            for finding in summary["errors"]:
                prefix = "ERROR" if finding["code"] == "CS-CONFIG" else "FAIL"
                output = sys.stderr if prefix == "ERROR" else sys.stdout
                print(
                    f"{prefix}: {path}: {finding['code']}: "
                    f"{finding['location']}: {finding['message']}",
                    file=output,
                )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
