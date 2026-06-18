#!/usr/bin/env python3
"""Fail-closed session ritual verifier (#1348)."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from framework_commands import format_framework_command  # noqa: E402
from policy import resolve_session_ritual_staleness_hours  # noqa: E402
from ritual_sentinel import (  # noqa: E402
    RitualState,
    read_ritual_state,
    ritual_state_path,
    ritual_step,
    write_ritual_state,
)

ENV_SKIP = "DEFT_SESSION_RITUAL_SKIP"
# The legacy subprocess runner capped each gated check via subprocess timeout=300.
# In-process calls (#1659) must preserve that bound so a hung entrypoint cannot turn
# the fail-closed step-0 gate into a permanent block (#1655 review).
ENTRYPOINT_TIMEOUT_SECONDS = 300.0
ENTRYPOINT_TIMEOUT_EXIT_CODE = 124
QUICK_STEPS: tuple[str, ...] = ("alignment", "branch_policy", "triage_welcome")
GATED_STEPS: tuple[str, ...] = ("doctor", "cache_fresh")
GATED_ENTRYPOINT_COMMANDS: dict[str, tuple[str, ...]] = {
    "doctor": ("doctor",),
    "cache_fresh": ("verify:cache-fresh",),
}


@dataclass(frozen=True)
class VerifyResult:
    code: int
    message: str
    tier: str
    state_path: Path
    bypassed: bool = False
    would_fail_code: int | None = None


Runner = Callable[[list[str], Path], tuple[int, str, str]]


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _truthy(raw: str | None) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


def _run_git(project_root: Path, args: list[str]) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError:
        return 127, "", "git executable not found on PATH"
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _git_head(project_root: Path) -> tuple[str | None, str | None]:
    code, out, err = _run_git(project_root, ["rev-parse", "--verify", "HEAD"])
    if code != 0 or not out:
        return None, err or "could not resolve git HEAD"
    return out, None


def _worktree_path(project_root: Path) -> str:
    code, out, _err = _run_git(project_root, ["rev-parse", "--show-toplevel"])
    if code == 0 and out:
        return str(Path(out).resolve())
    return str(project_root.resolve())


def _call_main(
    main_func: Callable[[list[str]], int],
    argv: list[str],
    *,
    timeout: float | None = None,
) -> tuple[int, str, str]:
    """Run an in-process entrypoint, bounding it with a timeout.

    The legacy subprocess runner passed ``timeout=300`` so a hung check could not
    block the step-0 gate indefinitely. In-process calls drop that protection, so
    the entrypoint runs in a daemon worker thread joined with the same bound; a
    hang returns a fail-closed timeout result instead of blocking dispatch (#1655).
    ``timeout`` resolves to ``ENTRYPOINT_TIMEOUT_SECONDS`` at call time when unset.
    """
    if timeout is None:
        timeout = ENTRYPOINT_TIMEOUT_SECONDS
    result: dict[str, tuple[int, str, str]] = {}
    real_stdout, real_stderr = sys.stdout, sys.stderr

    def _worker() -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = main_func(argv)
        except SystemExit as exc:
            raw_code = exc.code
            code = raw_code if isinstance(raw_code, int) else (0 if raw_code is None else 1)
        except Exception as exc:  # noqa: BLE001 -- ritual state must record failures
            message = f"{type(exc).__name__}: {exc}"
            captured_stderr = stderr.getvalue()
            stderr_value = f"{captured_stderr}\n{message}" if captured_stderr else message
            result["value"] = (2, stdout.getvalue(), stderr_value)
            return
        result["value"] = (int(code or 0), stdout.getvalue(), stderr.getvalue())

    worker = threading.Thread(target=_worker, name="deft-ritual-entrypoint", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        # A hung worker may still hold the process-global stdout/stderr redirect;
        # restore the real streams so the caller's fail-closed message survives.
        sys.stdout, sys.stderr = real_stdout, real_stderr
        label = getattr(main_func, "__name__", "entrypoint")
        return ENTRYPOINT_TIMEOUT_EXIT_CODE, "", f"{label} timed out after {timeout:g}s"
    return result.get("value", (2, "", "entrypoint produced no result"))


def _default_runner(args: list[str], cwd: Path) -> tuple[int, str, str]:
    command, *argv = args
    if command == "doctor":
        import doctor  # noqa: PLC0415

        return _call_main(doctor.cmd_doctor, ["--project-root", str(cwd), *argv])
    if command == "verify:cache-fresh":
        import preflight_cache  # noqa: PLC0415

        return _call_main(
            preflight_cache.main,
            ["--allow-missing-bootstrap", "--project-root", str(cwd), *argv],
        )
    return 2, "", f"unknown session ritual command: {command}"


def _step_passes(step: dict[str, Any] | None) -> bool:
    if not isinstance(step, dict):
        return False
    if step.get("deferred_reason"):
        return True
    return step.get("ok") is True


def _failed_step_message(tier_name: str, step_name: str, step: object) -> str:
    if step is None:
        return (
            f"session ritual {tier_name} step '{step_name}' is missing. "
            f"Run `{format_framework_command(['session:start'])}` before implementation dispatch."
        )
    if isinstance(step, dict) and step.get("deferred_reason"):
        return ""
    message = step.get("message") if isinstance(step, dict) else None
    suffix = f": {message}" if isinstance(message, str) and message else ""
    return f"session ritual {tier_name} step '{step_name}' failed{suffix}"


def _run_gated_step(
    project_root: Path,
    payload: dict[str, Any],
    step_name: str,
    *,
    runner: Runner,
    now: datetime,
) -> str | None:
    command = [*GATED_ENTRYPOINT_COMMANDS[step_name]]
    code, stdout, stderr = runner(command, project_root)
    message = stdout.strip() or stderr.strip() or f"{command[0]} exited {code}"
    payload.setdefault("gated_steps", {})[step_name] = ritual_step(
        ok=code == 0,
        ts=now,
        exit_code=code,
        message=message,
        command=command,
    )
    try:
        write_ritual_state(project_root, payload)
    except OSError as exc:
        return f"could not write session ritual state after {step_name}: {exc}"
    return None


def _evaluate_loaded_state(
    project_root: Path,
    state: RitualState,
    *,
    tier: str,
    now: datetime,
) -> tuple[int, str]:
    current_head, head_error = _git_head(project_root)
    if current_head is None:
        return 2, head_error or "could not resolve git HEAD"
    current_worktree = _worktree_path(project_root)
    if state.worktree_path != current_worktree:
        return (
            1,
            "session ritual state belongs to a different worktree "
            f"({state.worktree_path}); run `{format_framework_command(['session:start'])}` here.",
        )
    if state.git_head != current_head:
        return (
            1,
            "session ritual state is stale because git HEAD changed. "
            f"Run `{format_framework_command(['session:start'])}` again.",
        )
    staleness = resolve_session_ritual_staleness_hours(project_root)
    if staleness.source == "default-on-error":
        return 2, staleness.error or "session ritual staleness policy is invalid"
    max_age = timedelta(hours=staleness.hours)
    if now - state.started_at > max_age:
        start_command = format_framework_command(["session:start"])
        return (
            1,
            "session ritual state is stale "
            f"(older than {staleness.hours}h). Run `{start_command}` again.",
        )
    for step_name in QUICK_STEPS:
        step = state.quick_steps.get(step_name)
        if not _step_passes(step):
            return 1, _failed_step_message("quick", step_name, step)
    if tier == "gated":
        for step_name in GATED_STEPS:
            step = state.gated_steps.get(step_name)
            if not _step_passes(step):
                return 1, _failed_step_message("gated", step_name, step)
    return 0, f"OK session ritual {tier} tier is fresh."


def verify(
    project_root: Path,
    *,
    tier: str = "quick",
    now: datetime | None = None,
    runner: Runner | None = None,
    bypass: bool | None = None,
) -> VerifyResult:
    """Verify the session ritual state and optionally run gated steps."""
    if tier not in {"quick", "gated"}:
        return VerifyResult(
            2,
            f"tier must be 'quick' or 'gated', got {tier!r}",
            tier,
            ritual_state_path(project_root),
        )
    instant = now or _utc_now()
    is_bypassed = _truthy(os.environ.get(ENV_SKIP)) if bypass is None else bypass
    state_path = ritual_state_path(project_root)
    missing_state_file = not state_path.is_file()
    state, err = read_ritual_state(project_root)
    if state is None:
        code = 1 if missing_state_file else 2
        start_command = format_framework_command(["session:start"])
        message = (
            f"{err}. Run `{start_command}` before implementation dispatch."
            if code == 1
            else err or "ritual state invalid"
        )
        if is_bypassed:
            return VerifyResult(0, message, tier, state_path, True, code)
        return VerifyResult(code, message, tier, state_path)

    if tier == "gated" and not is_bypassed:
        precheck_code, precheck_message = _evaluate_loaded_state(
            project_root,
            state,
            tier="quick",
            now=instant,
        )
        if precheck_code != 0:
            return VerifyResult(precheck_code, precheck_message, tier, state_path)

        payload = dict(state.raw)
        gated = payload.setdefault("gated_steps", {})
        run_cmd = runner or _default_runner
        for step_name in GATED_STEPS:
            step = gated.get(step_name)
            if isinstance(step, dict) and step.get("deferred_reason"):
                continue
            if _step_passes(step):
                continue
            write_error = _run_gated_step(
                project_root,
                payload,
                step_name,
                runner=run_cmd,
                now=instant,
            )
            if write_error is not None:
                return VerifyResult(2, write_error, tier, state_path)
        state, err = read_ritual_state(project_root)
        if state is None:
            code = 2
            message = err or "ritual state invalid after gated update"
            return VerifyResult(code, message, tier, state_path)

    code, message = _evaluate_loaded_state(project_root, state, tier=tier, now=instant)
    if is_bypassed:
        return VerifyResult(0, message, tier, state_path, True, code if code else None)
    return VerifyResult(code, message, tier, state_path)


def _emit_json(result: VerifyResult) -> str:
    return json.dumps(
        {
            "ready": result.code == 0,
            "exit_code": result.code,
            "tier": result.tier,
            "message": result.message,
            "state_path": str(result.state_path),
            "bypassed": result.bypassed,
            "would_fail_code": result.would_fail_code,
        },
        sort_keys=True,
    )


def _emit_bypass_warning(result: VerifyResult) -> None:
    if result.bypassed and result.would_fail_code:
        print(
            f"[deft] WARNING: {ENV_SKIP}=1 bypassed a session ritual "
            f"failure ({result.message})",
            file=sys.stderr,
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_session_ritual.py",
        description="Fail-closed session ritual verifier (#1348).",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing .deft/ritual-state.json (default: cwd).",
    )
    parser.add_argument(
        "--tier",
        choices=("quick", "gated"),
        default="quick",
        help="Ritual tier to verify. Gated lazily runs doctor/cache checks.",
    )
    parser.add_argument("--json", action="store_true", dest="emit_json")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    result = verify(project_root, tier=args.tier)
    warning_needed = result.bypassed and result.would_fail_code is not None
    if args.emit_json:
        print(_emit_json(result))
    elif result.code == 0:
        if not warning_needed:
            print(result.message)
    else:
        print(result.message, file=sys.stderr)
    if warning_needed:
        _emit_bypass_warning(result)
    return result.code


if __name__ == "__main__":
    sys.exit(main())
