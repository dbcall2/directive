#!/usr/bin/env python3
"""Fail when runtime Python code hard-depends on go-task (#1659)."""

from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN_PATHS = (ROOT / "run", ROOT / "scripts")
SUBPROCESS_FUNCS = {"run", "check_call", "check_output", "Popen", "call"}


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    message: str


def _is_name_or_attr(node: ast.AST, dotted: str) -> bool:
    parts = dotted.split(".")
    current = node
    for expected in reversed(parts):
        if isinstance(current, ast.Attribute):
            if current.attr != expected:
                return False
            current = current.value
            continue
        if isinstance(current, ast.Name):
            return current.id == expected and expected == parts[0]
        return False
    return isinstance(current, ast.Name) and current.id == parts[0]


def _literal_first_arg(call: ast.Call) -> str | None:
    if not call.args:
        return None
    first = call.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    if isinstance(first, (ast.List, ast.Tuple)) and first.elts:
        head = first.elts[0]
        if isinstance(head, ast.Constant) and isinstance(head.value, str):
            return head.value
    return None


class Visitor(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path
        self.findings: list[Finding] = []
        self.subprocess_names = {"subprocess"}
        self.subprocess_func_names: set[str] = set()
        self.shutil_names = {"shutil"}
        self.shutil_which_names: set[str] = set()

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            local_name = alias.asname or alias.name
            if alias.name == "subprocess":
                self.subprocess_names.add(local_name)
            if alias.name == "shutil":
                self.shutil_names.add(local_name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        if node.module == "subprocess":
            for alias in node.names:
                if alias.name in SUBPROCESS_FUNCS:
                    self.subprocess_func_names.add(alias.asname or alias.name)
        if node.module == "shutil":
            for alias in node.names:
                if alias.name == "which":
                    self.shutil_which_names.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        if isinstance(node.func, ast.Attribute):
            if (
                isinstance(node.func.value, ast.Name)
                and node.func.value.id in self.subprocess_names
                and node.func.attr in SUBPROCESS_FUNCS
                and _literal_first_arg(node) == "task"
            ):
                self.findings.append(
                    Finding(
                        self.path,
                        node.lineno,
                        "runtime subprocess invocation of go-task is forbidden",
                    )
                )
            if (
                node.func.attr == "which"
                and (
                    _is_name_or_attr(node.func.value, "shutil")
                    or (
                        isinstance(node.func.value, ast.Name)
                        and node.func.value.id in self.shutil_names
                    )
                )
                and _literal_first_arg(node) == "task"
            ):
                self.findings.append(
                    Finding(
                        self.path,
                        node.lineno,
                        "runtime go-task PATH probe is forbidden",
                    )
                )
        if isinstance(node.func, ast.Name):
            if node.func.id in self.subprocess_func_names and _literal_first_arg(node) == "task":
                self.findings.append(
                    Finding(
                        self.path,
                        node.lineno,
                        "runtime subprocess invocation of go-task is forbidden",
                    )
                )
            if node.func.id in self.shutil_which_names and _literal_first_arg(node) == "task":
                self.findings.append(
                    Finding(
                        self.path,
                        node.lineno,
                        "runtime go-task PATH probe is forbidden",
                    )
                )
        self.generic_visit(node)


def _python_files() -> list[Path]:
    files = [ROOT / "run"]
    files.extend(
        path
        for path in sorted((ROOT / "scripts").glob("*.py"))
        if path.name != Path(__file__).name
    )
    return files


def scan() -> list[Finding]:
    findings: list[Finding] = []
    for path in _python_files():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            findings.append(Finding(path, getattr(exc, "lineno", 1) or 1, str(exc)))
            continue
        visitor = Visitor(path)
        visitor.visit(tree)
        findings.extend(visitor.findings)
    return findings


def main(argv: list[str] | None = None) -> int:
    _ = argv
    findings = scan()
    if not findings:
        print("No runtime go-task subprocess dependencies found")
        return 0
    print("Runtime go-task dependencies found:", file=sys.stderr)
    for finding in findings:
        rel = finding.path.relative_to(ROOT)
        print(f"  {rel}:{finding.line}: {finding.message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
