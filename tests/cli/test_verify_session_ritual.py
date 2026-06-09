from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

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


def _write_project_def(project_root: Path, policy: dict[str, Any] | None = None) -> None:
    path = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "T",
            "status": "running",
            "items": [],
            "policy": policy or {},
        },
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_state(
    project_root: Path,
    *,
    head: str,
    started_at: datetime,
    quick_steps: dict[str, dict[str, Any]] | None = None,
    gated_steps: dict[str, dict[str, Any]] | None = None,
) -> None:
    sentinel = _load_module("ritual_sentinel", SCRIPTS_DIR / "ritual_sentinel.py")
    quick_steps = quick_steps or {
        name: sentinel.ritual_step(ok=True, ts=started_at)
        for name in ("alignment", "branch_policy", "triage_welcome")
    }
    payload = sentinel.new_ritual_state_payload(
        session_id="test-session",
        git_head=head,
        worktree_path=str(project_root.resolve()),
        started_at=started_at,
        quick_steps=quick_steps,
        gated_steps=gated_steps or {},
    )
    sentinel.write_ritual_state(project_root, payload)


def test_missing_state_fails_closed(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    _init_git(tmp_path)

    result = verifier.verify(tmp_path, tier="quick", bypass=False)

    assert result.code == 1
    assert "task session:start" in result.message


def test_corrupt_state_is_config_error(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    _init_git(tmp_path)
    state_path = tmp_path / ".deft" / "ritual-state.json"
    state_path.parent.mkdir()
    state_path.write_text("{not json", encoding="utf-8")

    result = verifier.verify(tmp_path, tier="quick", bypass=False)

    assert result.code == 2
    assert "not valid JSON" in result.message


def test_quick_tier_accepts_fresh_state(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    head = _init_git(tmp_path)
    now = datetime(2026, 6, 9, 1, 0, tzinfo=UTC)
    _write_state(tmp_path, head=head, started_at=now)

    result = verifier.verify(
        tmp_path,
        tier="quick",
        now=now + timedelta(minutes=1),
        bypass=False,
    )

    assert result.code == 0
    assert "fresh" in result.message


def test_changed_head_stales_state(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    _init_git(tmp_path)
    now = datetime(2026, 6, 9, 1, 0, tzinfo=UTC)
    _write_state(tmp_path, head="deadbeef", started_at=now)

    result = verifier.verify(
        tmp_path,
        tier="quick",
        now=now + timedelta(minutes=1),
        bypass=False,
    )

    assert result.code == 1
    assert "git HEAD changed" in result.message


def test_stale_by_policy_window_fails(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    head = _init_git(tmp_path)
    _write_project_def(tmp_path, {"sessionRitualStalenessHours": 1})
    now = datetime(2026, 6, 9, 1, 0, tzinfo=UTC)
    _write_state(tmp_path, head=head, started_at=now)

    result = verifier.verify(
        tmp_path,
        tier="quick",
        now=now + timedelta(hours=2),
        bypass=False,
    )

    assert result.code == 1
    assert "older than 1h" in result.message


def test_gated_tier_lazily_records_missing_steps(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    head = _init_git(tmp_path)
    now = datetime(2026, 6, 9, 1, 0, tzinfo=UTC)
    _write_state(tmp_path, head=head, started_at=now)

    def runner(command: list[str], cwd: Path) -> tuple[int, str, str]:
        return 0, f"{' '.join(command)} ok", ""

    result = verifier.verify(
        tmp_path,
        tier="gated",
        now=now + timedelta(minutes=1),
        runner=runner,
        bypass=False,
    )

    assert result.code == 0
    state = json.loads((tmp_path / ".deft" / "ritual-state.json").read_text(encoding="utf-8"))
    assert state["gated_steps"]["doctor"]["ok"] is True
    assert state["gated_steps"]["cache_fresh"]["ok"] is True


def test_deferred_gated_step_satisfies_verifier(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    sentinel = _load_module("ritual_sentinel", SCRIPTS_DIR / "ritual_sentinel.py")
    head = _init_git(tmp_path)
    now = datetime(2026, 6, 9, 1, 0, tzinfo=UTC)
    _write_state(
        tmp_path,
        head=head,
        started_at=now,
        gated_steps={
            "doctor": sentinel.ritual_step(
                ok=True,
                ts=now,
                deferred_reason="already inspected manually",
            ),
            "cache_fresh": sentinel.ritual_step(ok=True, ts=now),
        },
    )

    result = verifier.verify(
        tmp_path,
        tier="gated",
        now=now + timedelta(minutes=1),
        bypass=False,
    )

    assert result.code == 0


def test_bypass_turns_missing_state_into_warning_result(tmp_path: Path) -> None:
    verifier = _load_module("verify_session_ritual", SCRIPTS_DIR / "verify_session_ritual.py")
    _init_git(tmp_path)

    result = verifier.verify(tmp_path, tier="quick", bypass=True)

    assert result.code == 0
    assert result.bypassed is True
    assert result.would_fail_code == 1
