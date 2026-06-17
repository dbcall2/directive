from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

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
        "migrate:vbrief",
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


def test_migrate_vbrief_runs_preflight_then_migrator(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, list[str]]] = []

    def fake_preflight(argv: list[str]) -> int:
        calls.append(("preflight", argv))
        return 0

    def fake_migrator(argv: list[str]) -> int:
        calls.append(("migrator", argv))
        return 0

    monkeypatch.setitem(sys.modules, "migrate_preflight", SimpleNamespace(main=fake_preflight))
    monkeypatch.setitem(sys.modules, "migrate_vbrief", SimpleNamespace(main=fake_migrator))

    result = framework_commands.run_framework_command(
        "migrate:vbrief",
        ["--", "--dry-run"],
        project_root=tmp_path,
        capture=True,
    )

    assert result.code == 0
    assert calls == [
        (
            "preflight",
            [
                "--project-root",
                str(tmp_path.resolve()),
                "--deft-root",
                str(REPO_ROOT),
            ],
        ),
        ("migrator", [str(tmp_path.resolve()), "--dry-run"]),
    ]


def test_migrate_vbrief_stops_when_preflight_fails(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []

    def fake_preflight(argv: list[str]) -> int:
        calls.append("preflight")
        return 1

    def fake_migrator(argv: list[str]) -> int:
        calls.append("migrator")
        return 0

    monkeypatch.setitem(sys.modules, "migrate_preflight", SimpleNamespace(main=fake_preflight))
    monkeypatch.setitem(sys.modules, "migrate_vbrief", SimpleNamespace(main=fake_migrator))

    result = framework_commands.run_framework_command(
        "migrate:vbrief",
        ["--dry-run"],
        project_root=tmp_path,
        capture=True,
    )

    assert result.code == 1
    assert calls == ["preflight"]
