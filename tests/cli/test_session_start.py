from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_module(name: str, path: Path):
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _init_git(project_root: Path) -> str:
    subprocess.run(["git", "init"], cwd=project_root, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=project_root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=project_root,
        check=True,
    )
    (project_root / "README.md").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=project_root, check=True)
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=project_root,
        check=True,
        capture_output=True,
    )
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=project_root,
        text=True,
    ).strip()


def test_run_session_start_records_quick_state(tmp_path: Path) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    head = _init_git(tmp_path)

    code, payload, lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
    )

    assert code == 0
    assert "Deft Directive active -- AGENTS.md loaded." in lines
    state_path = tmp_path / ".deft" / "ritual-state.json"
    assert state_path.is_file()
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["schemaVersion"] == 1
    assert state["git_head"] == head
    assert state["worktree_path"] == str(tmp_path.resolve())
    assert set(state["quick_steps"]) == {
        "alignment",
        "branch_policy",
        "triage_welcome",
    }
    assert state["quick_steps"]["branch_policy"]["ok"] is True
    assert payload["ready"] is True


def test_run_session_start_records_explicit_deferrals(tmp_path: Path) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)

    code, _payload, _lines = session_start.run_session_start(
        tmp_path,
        deferrals={
            "triage_welcome": "offline review only",
            "doctor": "run at dispatch",
        },
        write_history=False,
    )

    assert code == 0
    state = json.loads((tmp_path / ".deft" / "ritual-state.json").read_text(encoding="utf-8"))
    assert state["quick_steps"]["triage_welcome"]["deferred_reason"] == "offline review only"
    assert state["gated_steps"]["doctor"]["deferred_reason"] == "run at dispatch"


def test_run_session_start_records_triage_failure_and_can_defer(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)

    def fail_triage(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setitem(
        sys.modules,
        "triage_welcome",
        SimpleNamespace(
            run_default_mode=fail_triage,
            task_command_args=lambda args, *, task_prefix=None: [
                f"{task_prefix}{args[0]}",
                *args[1:],
            ],
        ),
    )

    code, payload, _lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
        task_prefix="deft:",
    )

    state_path = tmp_path / ".deft" / "ritual-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert code == 1
    assert payload["ready"] is False
    assert state["quick_steps"]["triage_welcome"]["ok"] is False
    assert state["quick_steps"]["triage_welcome"]["command"] == [
        "task",
        "deft:triage:welcome",
    ]
    assert "network down" in state["quick_steps"]["triage_welcome"]["message"]

    code, payload, _lines = session_start.run_session_start(
        tmp_path,
        deferrals={"triage_welcome": "network unavailable"},
        write_history=False,
    )

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert code == 0
    assert payload["ready"] is True
    assert state["quick_steps"]["triage_welcome"]["deferred_reason"] == (
        "network unavailable"
    )


def test_run_session_start_threads_task_prefix_to_triage_welcome(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)
    captured: dict[str, object] = {}

    def fake_task_command_args(args, *, task_prefix=None):
        captured["command_prefix"] = task_prefix
        return [f"{task_prefix}{args[0]}", *args[1:]]

    def fake_run_default_mode(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(exit_code=0)

    monkeypatch.setitem(
        sys.modules,
        "triage_welcome",
        SimpleNamespace(
            run_default_mode=fake_run_default_mode,
            task_command_args=fake_task_command_args,
        ),
    )

    code, _payload, _lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
        task_prefix="deft:",
    )

    state = json.loads((tmp_path / ".deft" / "ritual-state.json").read_text(encoding="utf-8"))
    assert code == 0
    assert captured["task_prefix"] == "deft:"
    assert captured["command_prefix"] == "deft:"
    assert state["quick_steps"]["triage_welcome"]["command"] == [
        "task",
        "deft:triage:welcome",
    ]


def test_run_git_captures_text_as_utf8(tmp_path: Path, monkeypatch) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    captured: dict[str, object] = {}

    def fake_run(*args, **kwargs):
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="ok\n", stderr="")

    monkeypatch.setattr(session_start.subprocess, "run", fake_run)

    code, stdout, stderr = session_start._run_git(tmp_path, ["status"])

    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert code == 0
    assert stdout == "ok"
    assert stderr == ""
    assert kwargs["encoding"] == "utf-8"
    assert kwargs["errors"] == "replace"


def test_parse_deferrals_rejects_unknown_step() -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")

    parsed, errors = session_start._parse_deferrals(["bogus=not today"])

    assert parsed == {}
    assert errors
    assert "unknown ritual step" in errors[0]
