"""Tests for the #1595 default codebase-map extractor."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import codebase_default_extractor as extractor  # noqa: E402


def _write_project_definition(project_root: Path) -> None:
    project_def = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    project_def.parent.mkdir(parents=True)
    project_def.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "Fixture",
                    "status": "running",
                    "architecture": {
                        "codeStructure": {
                            "version": "0.1",
                            "modules": [
                                {
                                    "id": "app",
                                    "name": "App",
                                    "purpose": "Application entry points.",
                                    "pathGlobs": ["app/**/*.py"],
                                },
                                {
                                    "id": "lib",
                                    "name": "Library",
                                    "purpose": "Shared helpers.",
                                    "pathGlobs": ["lib/**/*.py"],
                                },
                            ],
                            "pathOwnership": [],
                            "allowedPatterns": [],
                            "projectionManifest": [
                                {
                                    "path": ".planning/codebase/MAP.md",
                                    "kind": "codebase-map",
                                    "source": "plan.architecture.codeStructure",
                                    "generated": True,
                                }
                            ],
                        }
                    },
                },
            }
        ),
        encoding="utf-8",
    )


def test_curated_extractor_emits_modules_coupling_entrypoints_and_languages(
    tmp_path: Path,
) -> None:
    _write_project_definition(tmp_path)
    app = tmp_path / "app"
    lib = tmp_path / "lib"
    app.mkdir()
    lib.mkdir()
    (app / "main.py").write_text("from lib.util import thing\nthing()\n", encoding="utf-8")
    (lib / "util.py").write_text("def thing():\n    return 1\n", encoding="utf-8")

    artifact = extractor.build_codebase_map(tmp_path)

    assert artifact["formatVersion"] == "codebase-map.v1"
    assert artifact["contractVersion"] == "codebase-provider.v1"
    assert artifact["kind"] == "codebase-map"
    assert [module["id"] for module in artifact["modules"]] == ["app", "lib"]
    assert artifact["coupling"][0]["from"] == "app"
    assert artifact["coupling"][0]["to"] == "lib"
    assert artifact["entryPoints"][0]["path"] == "app/main.py"
    assert artifact["languageDistribution"] == [
        {"language": "Python", "files": 2, "derivedFrom": "extension-heuristic"}
    ]
    assert {entry["code"] for entry in artifact["degraded"]} == {"AST-FREE-HEURISTICS"}


def test_extractor_without_code_structure_derives_directory_modules(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\n", encoding="utf-8")
    (tmp_path / "node_modules" / "pkg").mkdir(parents=True)
    (tmp_path / "node_modules" / "pkg" / "index.js").write_text("", encoding="utf-8")

    artifact = extractor.build_codebase_map(tmp_path)

    assert artifact["modules"][0]["id"] == "src"
    assert {module["id"] for module in artifact["modules"]} == {"src"}
    degraded_codes = {entry["code"] for entry in artifact["degraded"]}
    assert "NO-CODESTRUCTURE" in degraded_codes
    assert "AST-FREE-HEURISTICS" in degraded_codes


def test_directory_fallback_marks_truncated_module_file_lists(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    for index in range(extractor.MAX_FILES_PER_MODULE + 1):
        (src / f"file_{index:03}.py").write_text("", encoding="utf-8")

    artifact = extractor.build_codebase_map(tmp_path)

    src_module = artifact["modules"][0]
    assert src_module["fileCount"] == extractor.MAX_FILES_PER_MODULE + 1
    assert len(src_module["files"]) == extractor.MAX_FILES_PER_MODULE
    assert {
        (entry["code"], entry.get("module")) for entry in artifact["degraded"]
    } >= {("MODULE-FILES-TRUNCATED", "src")}


def test_main_reports_config_error_without_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bad_path = tmp_path / "bad.vbrief.json"
    bad_path.write_text("{not-json", encoding="utf-8")

    exit_code = extractor.main(
        ["--project-root", str(tmp_path), "--path", str(bad_path)]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert captured.out == ""
    payload = json.loads(captured.err)
    assert payload["ok"] is False
    assert payload["path"] == str(bad_path)
    assert payload["errors"][0]["code"] == "CS-CONFIG"
    assert "not valid JSON" in payload["errors"][0]["message"]
