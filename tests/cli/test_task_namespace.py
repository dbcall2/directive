from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

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


def _write_framework(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "Taskfile.yml").write_text("version: '3'\n", encoding="utf-8")


def test_normalize_task_prefix() -> None:
    task_namespace = _load_module("task_namespace", SCRIPTS_DIR / "task_namespace.py")

    assert task_namespace.normalize_task_prefix(None) == ""
    assert task_namespace.normalize_task_prefix("") == ""
    assert task_namespace.normalize_task_prefix("deft") == "deft:"
    assert task_namespace.normalize_task_prefix("deft:") == "deft:"


def test_discovers_canonical_consumer_include(tmp_path: Path) -> None:
    task_namespace = _load_module("task_namespace", SCRIPTS_DIR / "task_namespace.py")
    project_root = tmp_path / "consumer"
    framework_root = project_root / ".deft" / "core"
    _write_framework(framework_root)
    project_root.mkdir(exist_ok=True)
    (project_root / "Taskfile.yml").write_text(
        """
version: '3'
includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
""".lstrip(),
        encoding="utf-8",
    )

    assert (
        task_namespace.discover_task_prefix(project_root, framework_root=framework_root)
        == "deft:"
    )


def test_discovers_alternate_inline_include_key(tmp_path: Path) -> None:
    task_namespace = _load_module("task_namespace", SCRIPTS_DIR / "task_namespace.py")
    project_root = tmp_path / "consumer"
    framework_root = project_root / "vendor" / "directive"
    _write_framework(framework_root)
    project_root.mkdir(exist_ok=True)
    (project_root / "Taskfile.yml").write_text(
        """
version: '3'
includes:
  framework: ./vendor/directive
""".lstrip(),
        encoding="utf-8",
    )

    assert (
        task_namespace.discover_task_prefix(project_root, framework_root=framework_root)
        == "framework:"
    )


def test_source_repo_without_outer_include_returns_empty(tmp_path: Path) -> None:
    task_namespace = _load_module("task_namespace", SCRIPTS_DIR / "task_namespace.py")
    framework_root = tmp_path / "directive"
    _write_framework(framework_root)
    (framework_root / "Taskfile.yml").write_text(
        """
version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
""".lstrip(),
        encoding="utf-8",
    )

    assert task_namespace.discover_task_prefix(framework_root, framework_root=framework_root) == ""


def test_explicit_and_env_overrides_win(tmp_path: Path, monkeypatch) -> None:
    task_namespace = _load_module("task_namespace", SCRIPTS_DIR / "task_namespace.py")
    project_root = tmp_path / "consumer"
    framework_root = project_root / ".deft" / "core"
    _write_framework(framework_root)
    project_root.mkdir(exist_ok=True)
    (project_root / "Taskfile.yml").write_text(
        """
version: '3'
includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
""".lstrip(),
        encoding="utf-8",
    )

    monkeypatch.setenv("DEFT_TASK_PREFIX", "envns")

    assert (
        task_namespace.resolve_task_prefix(
            project_root,
            framework_root=framework_root,
            explicit="cli",
        )
        == "cli:"
    )
    assert (
        task_namespace.resolve_task_prefix(
            project_root,
            framework_root=framework_root,
        )
        == "envns:"
    )
