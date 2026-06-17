"""Tests for the #1595 codeStructure profile validator."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import code_structure_validate as csv_validate  # noqa: E402


def _record(**overrides: object) -> dict:
    record: dict = {
        "version": "0.1",
        "modules": [
            {
                "id": "cli",
                "name": "CLI",
                "purpose": "Command-line entry points and orchestration.",
                "pathGlobs": ["scripts/*.py", "tasks/*.yml"],
                "owner": "directive",
            },
            {
                "id": "tests",
                "name": "Tests",
                "purpose": "Regression coverage for framework behavior.",
                "pathGlobs": ["tests/**/*.py"],
            },
        ],
        "pathOwnership": [
            {
                "pathGlob": "scripts/code_structure_validate.py",
                "module": "cli",
                "owner": "directive",
            }
        ],
        "allowedPatterns": [
            {
                "id": "stdlib-cli",
                "module": "cli",
                "name": "Stdlib CLI",
                "description": "Validator scripts use stdlib argparse/json/pathlib only.",
            }
        ],
        "projectionManifest": [
            {
                "path": ".planning/codebase/MAP.md",
                "kind": "codebase-map",
                "source": csv_validate.PLAN_HOME,
                "generated": True,
            }
        ],
        "filePurposeOverrides": [
            {
                "path": "scripts/code_structure_validate.py",
                "module": "cli",
                "purpose": "Validates authored codeStructure metadata.",
            }
        ],
        "glossaryRefs": [{"term": "projection", "uri": "docs/codebase-map-source-of-truth.md"}],
    }
    record.update(overrides)
    return record


def _vbrief(record: dict) -> dict:
    return {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Code structure",
            "status": "running",
            "items": [],
            "architecture": {"codeStructure": record},
        },
    }


def _fallback_vbrief(record: dict) -> dict:
    return {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "Code structure",
            "status": "running",
            "items": [],
        },
        "x-directive/architecture": {"codeStructure": record},
    }


def _codes(result: csv_validate.ValidationResult) -> set[str]:
    return {finding.code for finding in result.errors}


def _warning_codes(result: csv_validate.ValidationResult) -> set[str]:
    return {finding.code for finding in result.warnings}


class TestValidateCodeStructure:
    def test_valid_record_passes(self) -> None:
        result = csv_validate.validate_code_structure(_record(), source="fixture")
        assert result.ok, [finding.message for finding in result.errors]

    def test_unknown_future_keys_are_tolerated(self) -> None:
        data = _record(
            futureTopLevel={"kept": True},
            modules=[
                {
                    "id": "cli",
                    "name": "CLI",
                    "purpose": "Command-line entry points.",
                    "pathGlobs": ["scripts/*.py"],
                    "futureModuleKey": "allowed",
                }
            ],
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert result.ok

    def test_derived_fact_keys_are_rejected(self) -> None:
        data = _record(
            modules=[
                {
                    "id": "cli",
                    "name": "CLI",
                    "purpose": "Command-line entry points.",
                    "pathGlobs": ["scripts/*.py"],
                    "imports": ["tests.helpers"],
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-DERIVED-FACT" in _codes(result)

    def test_bad_module_id_fails(self) -> None:
        data = _record(
            modules=[
                {
                    "id": "CLI Module",
                    "name": "CLI",
                    "purpose": "Command-line entry points.",
                    "pathGlobs": ["scripts/*.py"],
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-MODULE-ID" in _codes(result)

    def test_unsafe_glob_fails(self) -> None:
        data = _record(
            modules=[
                {
                    "id": "cli",
                    "name": "CLI",
                    "purpose": "Command-line entry points.",
                    "pathGlobs": ["../scripts/*.py"],
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-GLOB" in _codes(result)

    def test_unknown_module_reference_fails(self) -> None:
        data = _record(
            allowedPatterns=[
                {
                    "id": "bad-ref",
                    "module": "missing",
                    "name": "Bad ref",
                    "description": "References a missing module.",
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-MODULE-REF" in _codes(result)

    def test_duplicate_module_glob_conflict_fails(self) -> None:
        data = _record(
            modules=[
                {
                    "id": "cli",
                    "name": "CLI",
                    "purpose": "Command-line entry points.",
                    "pathGlobs": ["scripts/*.py"],
                },
                {
                    "id": "runtime",
                    "name": "Runtime",
                    "purpose": "Runtime helpers.",
                    "pathGlobs": ["scripts/*.py"],
                },
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-GLOB-CONFLICT" in _codes(result)

    def test_duplicate_path_ownership_conflict_fails(self) -> None:
        data = _record(
            pathOwnership=[
                {"pathGlob": "scripts/*.py", "module": "cli"},
                {"pathGlob": "scripts/*.py", "module": "tests"},
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-OWNERSHIP-CONFLICT" in _codes(result)

    def test_allowed_pattern_applies_to_requires_safe_paths(self) -> None:
        data = _record(
            allowedPatterns=[
                {
                    "id": "unsafe-applies-to",
                    "module": "cli",
                    "name": "Unsafe appliesTo",
                    "description": "Exercises path validation for pattern scopes.",
                    "appliesTo": ["../../../etc/shadow"],
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        assert "CS-PATH" in _codes(result)

    def test_projection_entry_requires_safe_path_and_generated_flag(self) -> None:
        data = _record(
            projectionManifest=[
                {
                    "path": "/tmp/MAP.md",
                    "kind": "codebase-map",
                    "source": csv_validate.PLAN_HOME,
                    "generated": "yes",
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        codes = _codes(result)
        assert "CS-PATH" in codes
        assert "CS-PROJECTION" in codes

    def test_projection_entry_rejects_runner_commands_and_requires_generated_true(self) -> None:
        data = _record(
            projectionManifest=[
                {
                    "path": ".planning/codebase/MAP.md",
                    "kind": "codebase-map",
                    "source": csv_validate.PLAN_HOME,
                    "generated": False,
                    "task": "task codebase:map",
                    "freshnessTask": "task verify:codebase-map-fresh",
                }
            ]
        )
        result = csv_validate.validate_code_structure(data, source="fixture")
        codes = _codes(result)
        assert "CS-PROJECTION" in codes
        assert "CS-PROJECTION-COMMAND" in codes

    def test_existing_projection_requires_generated_banner(self, tmp_path: Path) -> None:
        projection = tmp_path / ".planning" / "codebase" / "MAP.md"
        projection.parent.mkdir(parents=True)
        projection.write_text("# Hand-authored map\n", encoding="utf-8")

        result = csv_validate.validate_code_structure(
            _record(glossaryRefs=[]), source="fixture", project_root=tmp_path
        )

        assert "CS-PROJECTION-BANNER" in _codes(result)

    def test_glossary_ref_uri_must_exist_when_project_root_is_known(self, tmp_path: Path) -> None:
        result = csv_validate.validate_code_structure(
            _record(glossaryRefs=[{"term": "missing", "uri": "docs/missing.md"}]),
            source="fixture",
            project_root=tmp_path,
        )
        assert "CS-GLOSSARY-URI" in _codes(result)

    def test_boundedness_findings_warn_without_failing(self) -> None:
        overrides = [
            {"path": f"scripts/file_{index}.py", "purpose": "Fixture override."}
            for index in range(11)
        ]
        result = csv_validate.validate_code_structure(
            _record(filePurposeOverrides=overrides), source="fixture"
        )
        assert result.ok
        assert "CS-BOUNDEDNESS" in _warning_codes(result)


class TestExtractionAndCli:
    def test_extracts_from_plan_architecture(self) -> None:
        extracted = csv_validate.extract_code_structure(_vbrief(_record()))
        assert extracted is not None
        assert extracted.home == csv_validate.PLAN_HOME
        assert extracted.record["version"] == "0.1"

    def test_extracts_from_consumer_namespace_fallback(self) -> None:
        extracted = csv_validate.extract_code_structure(_fallback_vbrief(_record()))
        assert extracted is not None
        assert extracted.home == csv_validate.DIRECTIVE_HOME

    def test_file_with_both_homes_fails(self, tmp_path: Path) -> None:
        path = tmp_path / "code-structure.vbrief.json"
        payload = _vbrief(_record())
        payload["x-directive/architecture"] = {"codeStructure": _record()}
        path.write_text(json.dumps(payload), encoding="utf-8")

        result = csv_validate.validate_file(path)

        assert "CS-HOME-CONFLICT" in _codes(result)

    def test_cli_validates_explicit_path(self, tmp_path: Path) -> None:
        path = tmp_path / "code-structure.vbrief.json"
        path.write_text(json.dumps(_vbrief(_record())), encoding="utf-8")
        assert csv_validate.main(["--path", str(path)]) == 0

    def test_cli_reports_invalid_path(self, tmp_path: Path) -> None:
        path = tmp_path / "code-structure.vbrief.json"
        bad = _record(modules=[])
        path.write_text(json.dumps(_vbrief(bad)), encoding="utf-8")
        assert csv_validate.main(["--path", str(path)]) == 1

    def test_cli_json_reports_prior_summary_before_config_error(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        good = tmp_path / "good.vbrief.json"
        bad = tmp_path / "bad.vbrief.json"
        good.write_text(json.dumps(_vbrief(_record())), encoding="utf-8")
        bad.write_text("[]", encoding="utf-8")

        exit_code = csv_validate.main(["--json", "--path", str(good), "--path", str(bad)])

        assert exit_code == 2
        captured = capsys.readouterr()
        payload = json.loads(captured.out)
        assert payload["ok"] is False
        assert [entry["path"] for entry in payload["validated"]] == [str(good), str(bad)]
        assert payload["validated"][0]["ok"] is True
        assert payload["validated"][1]["errors"][0]["code"] == "CS-CONFIG"

    def test_default_discovery_finds_project_definition(self, tmp_path: Path) -> None:
        project_def = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
        project_def.parent.mkdir(parents=True)
        project_def.write_text(json.dumps(_vbrief(_record())), encoding="utf-8")
        found = csv_validate.discover_code_structure_paths(tmp_path)
        assert found == [project_def]

    def test_default_discovery_finds_architecture_sibling_for_home_gate(
        self, tmp_path: Path
    ) -> None:
        arch = tmp_path / "vbrief" / "architecture"
        arch.mkdir(parents=True)
        path = arch / "code-structure.vbrief.json"
        path.write_text(json.dumps(_fallback_vbrief(_record(glossaryRefs=[]))), encoding="utf-8")
        found = csv_validate.discover_code_structure_paths(tmp_path)
        assert found == [path]

    def test_default_validation_rejects_architecture_sibling(self, tmp_path: Path) -> None:
        arch = tmp_path / "vbrief" / "architecture"
        arch.mkdir(parents=True)
        path = arch / "code-structure.vbrief.json"
        path.write_text(json.dumps(_fallback_vbrief(_record(glossaryRefs=[]))), encoding="utf-8")

        assert csv_validate.main(["--project-root", str(tmp_path)]) == 1
