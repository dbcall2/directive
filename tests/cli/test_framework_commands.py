from __future__ import annotations

import sys
from pathlib import Path

# Make ``scripts/`` importable when running ``pytest tests/``.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import framework_commands  # noqa: E402


def test_format_framework_command_defaults_to_deft_surface() -> None:
    assert (
        framework_commands.format_framework_command(["triage:welcome", "--onboard"])
        == "deft triage:welcome --onboard"
    )


def test_format_framework_command_preserves_task_prefixed_surface() -> None:
    assert (
        framework_commands.format_framework_command(
            ["triage:welcome", "--onboard"],
            surface="task",
            task_prefix="deft",
        )
        == "task deft:triage:welcome --onboard"
    )


def test_normalize_task_separator_keeps_taskfile_pass_through_compatible() -> None:
    assert framework_commands.normalize_task_separator(["--", "--batch"]) == ["--batch"]
    assert framework_commands.normalize_task_separator(["--batch"]) == ["--batch"]


def test_issue_1659_runtime_commands_are_registered() -> None:
    for name in (
        "core:validate",
        "core:lint",
        "core:test",
        "doctor",
        "session:start",
        "triage:welcome",
        "verify:cache-fresh",
        "verify:no-task-runtime",
        "check:consumer",
        "check:framework-source",
    ):
        assert framework_commands.has_command(name)


def test_unknown_command_returns_cli_shaped_failure() -> None:
    result = framework_commands.run_framework_command("__missing__", capture=True)

    assert result.code == 2
    assert "unknown framework command" in result.stderr
