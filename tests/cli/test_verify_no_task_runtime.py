from __future__ import annotations

import sys
from pathlib import Path

# Make ``scripts/`` importable when running ``pytest tests/``.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import verify_no_task_runtime  # noqa: E402


def test_scan_allows_non_task_subprocesses(tmp_path: Path, monkeypatch) -> None:
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import subprocess\n"
        'subprocess.run(["git", "status"], check=True)\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(verify_no_task_runtime, "_python_files", lambda: [probe])

    assert verify_no_task_runtime.scan() == []


def test_scan_flags_task_subprocess_and_path_probe(tmp_path: Path, monkeypatch) -> None:
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import shutil\n"
        "import subprocess\n"
        'subprocess.check_output(["task", "check"])\n'
        'shutil.which("task")\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(verify_no_task_runtime, "_python_files", lambda: [probe])

    findings = verify_no_task_runtime.scan()

    assert [finding.line for finding in findings] == [3, 4]
    assert findings[0].message == "runtime subprocess invocation of go-task is forbidden"
    assert findings[1].message == "runtime go-task PATH probe is forbidden"
