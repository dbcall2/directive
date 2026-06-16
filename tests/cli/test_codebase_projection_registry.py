"""Tests for the #1595 projection-kind registry."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import codebase_projection_registry as registry  # noqa: E402


def test_codebase_map_kind_resolves_contract_versions() -> None:
    projection = registry.resolve_projection_kind("codebase-map")
    assert projection.artifact_format_version == "codebase-map.v1"
    assert projection.provider_contract_version == "codebase-provider.v1"
    assert projection.generate_action == "generate-codebase-map"
    assert not projection.generate_action.startswith("task ")


def test_unknown_kind_fails() -> None:
    with pytest.raises(KeyError):
        registry.resolve_projection_kind("unknown-map")


def test_cli_lists_registered_kinds(capsys: pytest.CaptureFixture[str]) -> None:
    assert registry.main(["--list"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["kind"] == "codebase-map"


def test_cli_list_takes_precedence_over_kind(capsys: pytest.CaptureFixture[str]) -> None:
    assert registry.main(["--list", "--kind", "codebase-map"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert isinstance(payload, list)
    assert payload[0]["kind"] == "codebase-map"
