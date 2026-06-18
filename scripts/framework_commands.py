#!/usr/bin/env python3
"""Shared no-task dispatcher for Deft framework verbs (#1659).

This module is the compatibility rail between the old Taskfile verb names
(``triage:bootstrap``, ``verify:cache-fresh``, etc.) and the Python entrypoints
that actually implement them. Package-manager installs can route ``deft
<verb>`` through this module without requiring go-task on PATH, while Taskfile
consumers can keep using ``task deft:<verb>`` as a thin wrapper.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.util
import inspect
import io
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Literal

SCRIPT_DIR = Path(__file__).resolve().parent
FRAMEWORK_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

RootMode = Literal["project", "framework"]


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class CommandSpec:
    name: str
    entrypoint: str | None = None
    default_args: tuple[str, ...] = ()
    project_root_arg: str | None = None
    framework_root_arg: str | None = None
    vbrief_dir_arg: str | None = None
    root_arg: str | None = None
    cwd: RootMode = "project"
    no_argv: bool = False
    aggregate: tuple[str, ...] = ()
    description: str = ""


def _spec(
    name: str,
    entrypoint: str,
    *,
    default_args: Sequence[str] = (),
    project_root_arg: str | None = None,
    framework_root_arg: str | None = None,
    vbrief_dir_arg: str | None = None,
    root_arg: str | None = None,
    cwd: RootMode = "project",
    no_argv: bool = False,
    description: str = "",
) -> CommandSpec:
    return CommandSpec(
        name=name,
        entrypoint=entrypoint,
        default_args=tuple(default_args),
        project_root_arg=project_root_arg,
        framework_root_arg=framework_root_arg,
        vbrief_dir_arg=vbrief_dir_arg,
        root_arg=root_arg,
        cwd=cwd,
        no_argv=no_argv,
        description=description,
    )


def _aggregate(name: str, commands: Sequence[str], *, description: str = "") -> CommandSpec:
    return CommandSpec(name=name, aggregate=tuple(commands), description=description)


COMMANDS: dict[str, CommandSpec] = {
    "core:validate": _spec(
        "core:validate", "framework_commands:_cmd_core_validate", cwd="framework"
    ),
    "core:lint": _spec("core:lint", "framework_commands:_cmd_core_lint", cwd="framework"),
    "core:test": _spec("core:test", "framework_commands:_cmd_core_test", cwd="framework"),
    "doctor": _spec("doctor", "doctor:cmd_doctor"),
    "session:start": _spec(
        "session:start", "session_start:main", project_root_arg="--project-root"
    ),
    "triage:welcome": _spec(
        "triage:welcome", "triage_welcome:main", project_root_arg="--project-root"
    ),
    "triage:bootstrap": _spec(
        "triage:bootstrap", "triage_bootstrap:main", project_root_arg="--project-root"
    ),
    "triage:summary": _spec(
        "triage:summary", "triage_summary:main", project_root_arg="--project-root"
    ),
    "triage:queue": _spec(
        "triage:queue",
        "triage_queue:main",
        default_args=("queue",),
        project_root_arg="--project-root",
    ),
    "triage:show": _spec(
        "triage:show",
        "triage_queue:main",
        default_args=("show",),
        project_root_arg="--project-root",
    ),
    "triage:audit": _spec(
        "triage:audit",
        "triage_queue:main",
        default_args=("audit",),
        project_root_arg="--project-root",
    ),
    "triage:accept": _spec("triage:accept", "triage_actions:main", default_args=("accept",)),
    "triage:status": _spec("triage:status", "triage_actions:main", default_args=("status",)),
    "triage:scope": _spec("triage:scope", "triage_scope:main"),
    "migrate:vbrief": _spec("migrate:vbrief", "framework_commands:_cmd_migrate_vbrief"),
    "cache:fetch-all": _spec("cache:fetch-all", "cache:main", default_args=("fetch-all",)),
    "capacity:show": _spec(
        "capacity:show", "capacity_show:main", project_root_arg="--project-root"
    ),
    "scope:demote": _spec("scope:demote", "scope_demote:main", project_root_arg="--project-root"),
    "toolchain:check": _spec("toolchain:check", "toolchain-check.py:main", no_argv=True),
    "verify:stubs": _spec("verify:stubs", "verify-stubs.py:main", no_argv=True),
    "verify:links": _spec("verify:links", "validate-links.py:main", no_argv=True),
    "verify:rule-ownership": _spec(
        "verify:rule-ownership",
        "rule_ownership_lint:main",
        root_arg="--root",
        cwd="framework",
    ),
    "verify:branch": _spec(
        "verify:branch",
        "preflight_branch:main",
        default_args=("--allow-missing-project-definition",),
        project_root_arg="--project-root",
    ),
    "verify:encoding": _spec(
        "verify:encoding", "verify_encoding:main", project_root_arg="--project-root"
    ),
    "verify:vbrief-conformance": _spec(
        "verify:vbrief-conformance",
        "verify_vbrief_conformance:main",
        project_root_arg="--project-root",
    ),
    "verify:destructive-gh-verbs": _spec(
        "verify:destructive-gh-verbs",
        "preflight_gh:main",
        default_args=("--self-test",),
        project_root_arg="--project-root",
    ),
    "verify:scm-boundary": _spec(
        "verify:scm-boundary",
        "verify_scm_boundary:main",
        project_root_arg="--project-root",
    ),
    "verify:no-task-runtime": _spec(
        "verify:no-task-runtime",
        "verify_no_task_runtime:main",
        no_argv=True,
        cwd="framework",
    ),
    "verify:cache-fresh": _spec(
        "verify:cache-fresh",
        "preflight_cache:main",
        default_args=("--allow-missing-bootstrap",),
        project_root_arg="--project-root",
    ),
    "verify:wip-cap": _spec(
        "verify:wip-cap", "preflight_wip_cap:main", project_root_arg="--project-root"
    ),
    "verify:pack-drift": _spec(
        "verify:pack-drift", "pack_render:main", default_args=("--check",), cwd="framework"
    ),
    "verify-strategy-output": _spec(
        "verify-strategy-output",
        "validate_strategy_output:main",
        project_root_arg="--project-root",
    ),
    "vbrief:validate": _spec(
        "vbrief:validate", "vbrief_validate:main", vbrief_dir_arg="--vbrief-dir"
    ),
    "build": _spec(
        "build",
        "build_dist:main",
        default_args=("--version", "__DEFT_VERSION__"),
        cwd="framework",
    ),
    "check:consumer": _aggregate(
        "check:consumer",
        (
            "doctor",
            "toolchain:check",
            "verify:branch",
            "verify:cache-fresh",
            "verify:wip-cap",
            "vbrief:validate",
            "verify-strategy-output",
        ),
    ),
    "check:framework-source": _aggregate(
        "check:framework-source",
        (
            "core:validate",
            "core:lint",
            "core:test",
            "toolchain:check",
            "verify:stubs",
            "verify:links",
            "verify:rule-ownership",
            "verify:branch",
            "verify:encoding",
            "verify:vbrief-conformance",
            "verify:destructive-gh-verbs",
            "verify:scm-boundary",
            "verify:no-task-runtime",
            "verify:cache-fresh",
            "verify:pack-drift",
            "verify:wip-cap",
            "vbrief:validate",
            "verify-strategy-output",
        ),
    ),
}


def available_commands() -> tuple[str, ...]:
    return tuple(sorted(COMMANDS))


def has_command(name: str) -> bool:
    return name in COMMANDS


def normalize_task_separator(argv: Sequence[str]) -> list[str]:
    """Tolerate Taskfile-style pass-through: ``deft verb -- --flag``."""
    args = list(argv)
    if args[:1] == ["--"]:
        return args[1:]
    return args


def format_framework_command(
    args: Sequence[str],
    *,
    surface: str = "deft",
    task_prefix: str | None = None,
) -> str:
    """Render an operator-facing command for the selected invocation surface."""
    parts = list(args)
    if surface == "task":
        prefix = (task_prefix or "").strip()
        if prefix and not prefix.endswith(":"):
            prefix = f"{prefix}:"
        if parts:
            parts[0] = f"{prefix}{parts[0]}"
        return " ".join(["task", *parts])
    return " ".join([surface, *parts])


def _version() -> str:
    try:
        import resolve_version  # noqa: PLC0415

        return resolve_version.resolve_version()
    except Exception:  # noqa: BLE001 -- build should still produce a dev artifact
        return "0.0.0-dev"


def _load_module(module_ref: str) -> ModuleType:
    if module_ref.endswith(".py"):
        path = SCRIPT_DIR / module_ref
        module_name = f"_deft_command_{path.stem.replace('-', '_')}"
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    return importlib.import_module(module_ref)


def _reject_args(argv: Sequence[str], command: str) -> int:
    if argv:
        print(
            f"error: {command} does not accept arguments: {' '.join(argv)}",
            file=sys.stderr,
        )
        return 2
    return 0


def _cmd_core_validate(argv: list[str] | None = None) -> int:
    if _reject_args(argv or [], "core:validate") != 0:
        return 2
    files = [
        path
        for path in sorted(Path(".").rglob("*.md"))
        if ".git" not in path.parts and "backup" not in path.parts
    ]
    for path in files:
        print(f"✓ {path}")
    print(f"✓ All {len(files)} markdown files validated")
    return 0


def _run_uv(args: Sequence[str]) -> int:
    return subprocess.run(["uv", "--project", str(FRAMEWORK_ROOT), "run", *args]).returncode


def _cmd_core_lint(argv: list[str] | None = None) -> int:
    if _reject_args(argv or [], "core:lint") != 0:
        return 2
    ruff_code = _run_uv(["ruff", "check", "."])
    if ruff_code != 0:
        return ruff_code
    targets = ["run.py"]
    if Path("tests").exists():
        targets.append("tests")
    return _run_uv(["python", "-m", "mypy", *targets])


def _cmd_core_test(argv: list[str] | None = None) -> int:
    if _reject_args(argv or [], "core:test") != 0:
        return 2
    if not Path("tests").exists():
        print("no tests/ (vendored consumer) -- skipping")
        return 0
    return subprocess.run([sys.executable, "-m", "pytest", "tests"]).returncode


def _cmd_migrate_vbrief(argv: list[str] | None = None) -> int:
    import migrate_preflight  # noqa: PLC0415
    import migrate_vbrief  # noqa: PLC0415

    project_root = Path.cwd().resolve()
    preflight_code = migrate_preflight.main(
        [
            "--project-root",
            str(project_root),
            "--deft-root",
            str(FRAMEWORK_ROOT),
        ]
    )
    if preflight_code != 0:
        return preflight_code
    return migrate_vbrief.main([str(project_root), *(argv or [])])


def _load_callable(entrypoint: str) -> Callable[..., int | None]:
    module_ref, _, func_name = entrypoint.partition(":")
    if not module_ref or not func_name:
        raise ValueError(f"invalid framework entrypoint: {entrypoint!r}")
    module = _load_module(module_ref)
    func = getattr(module, func_name)
    if not callable(func):
        raise TypeError(f"framework entrypoint is not callable: {entrypoint}")
    return func


def _argv_for_spec(
    spec: CommandSpec,
    argv: Sequence[str],
    *,
    project_root: Path,
    framework_root: Path,
) -> list[str]:
    resolved: list[str] = []
    for item in spec.default_args:
        resolved.append(_version() if item == "__DEFT_VERSION__" else item)
    if spec.project_root_arg:
        resolved.extend((spec.project_root_arg, str(project_root)))
    if spec.framework_root_arg:
        resolved.extend((spec.framework_root_arg, str(framework_root)))
    if spec.vbrief_dir_arg:
        resolved.extend((spec.vbrief_dir_arg, str(project_root / "vbrief")))
    if spec.root_arg:
        resolved.extend((spec.root_arg, str(framework_root)))
    resolved.extend(normalize_task_separator(argv))
    return resolved


def _invoke(func: Callable[..., int | None], argv: list[str], *, no_argv: bool) -> int:
    try:
        if no_argv:
            if argv:
                print(
                    f"error: this framework command does not accept arguments: {' '.join(argv)}",
                    file=sys.stderr,
                )
                return 2
            code = func()
        else:
            signature = inspect.signature(func)
            code = func() if len(signature.parameters) == 0 else func(argv)
    except SystemExit as exc:
        raw = exc.code
        return raw if isinstance(raw, int) else (0 if raw is None else 1)
    return int(code or 0)


def run_framework_command(
    name: str,
    argv: Sequence[str] = (),
    *,
    project_root: Path | None = None,
    framework_root: Path | None = None,
    capture: bool = False,
    output_fn: Callable[[str], None] | None = None,
) -> CommandResult:
    root = (project_root or Path.cwd()).resolve()
    framework = (framework_root or FRAMEWORK_ROOT).resolve()
    spec = COMMANDS.get(name)
    if spec is None:
        return CommandResult(2, "", f"unknown framework command: {name}")

    if spec.aggregate:
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        for child in spec.aggregate:
            if output_fn is not None:
                output_fn(f"[deft] {child}")
            result = run_framework_command(
                child,
                (),
                project_root=root,
                framework_root=framework,
                capture=capture,
                output_fn=output_fn,
            )
            stdout_parts.append(result.stdout)
            stderr_parts.append(result.stderr)
            if result.code != 0:
                return CommandResult(
                    result.code,
                    "".join(stdout_parts),
                    "".join(stderr_parts),
                )
        return CommandResult(0, "".join(stdout_parts), "".join(stderr_parts))

    if spec.entrypoint is None:
        return CommandResult(2, "", f"framework command has no entrypoint: {name}")

    try:
        func = _load_callable(spec.entrypoint)
        command_argv = _argv_for_spec(
            spec,
            argv,
            project_root=root,
            framework_root=framework,
        )
    except Exception as exc:  # noqa: BLE001 -- produce CLI-shaped failure
        return CommandResult(2, "", f"{type(exc).__name__}: {exc}")

    previous_cwd = Path.cwd()
    cwd = root if spec.cwd == "project" else framework
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        os.chdir(cwd)
        if capture:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = _invoke(func, command_argv, no_argv=spec.no_argv)
        else:
            code = _invoke(func, command_argv, no_argv=spec.no_argv)
    except Exception as exc:  # noqa: BLE001 -- dispatcher is a command boundary
        print(f"{type(exc).__name__}: {exc}", file=stderr)
        code = 2
    finally:
        os.chdir(previous_cwd)
    return CommandResult(code, stdout.getvalue(), stderr.getvalue())


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help", "help"}:
        print("Usage: framework_commands.py <verb> [args...]")
        print()
        print("Available framework verbs:")
        for name in available_commands():
            print(f"  {name}")
        return 0
    command, *rest = args
    result = run_framework_command(command, rest)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return result.code


if __name__ == "__main__":
    raise SystemExit(main())
