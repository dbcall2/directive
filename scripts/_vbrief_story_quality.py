"""Shared story-quality checks for decomposition and swarm readiness."""

from __future__ import annotations

import re
from typing import Any

BROAD_FILE_SCOPE_ROOTS = {"backend", "frontend", "docs", "vbrief"}
CODE_PATH_TERMS = (
    "api",
    "cli",
    "component",
    "config",
    "database",
    "endpoint",
    "file",
    "handler",
    "model",
    "module",
    "repository",
    "route",
    "schema",
    "script",
    "service",
    "source",
    "src/",
)
VERIFY_EVIDENCE_TERMS = (
    "assert",
    "evidence",
    "fixture",
    "report",
    "spec",
    "test",
    "tests/",
    "verify",
)
GENERIC_VERIFY_COMMANDS = {
    "cargo test",
    "go test ./...",
    "npm run test",
    "npm test",
    "pytest",
    "task check",
}
PLACEHOLDER_ACCEPTANCE_PATTERNS = (
    "acceptance criteria for",
    "copy from parent",
    "copy from specification",
    "placeholder",
    "refine from parent",
    "tbd",
    "to be defined",
    "to refine",
    "to refine from parent scope",
    "todo",
)
DOCS_ONLY_ACCEPTANCE_PATTERNS = (
    "docs updated",
    "documentation updated",
    "readme updated",
    "update docs",
    "update documentation",
    "update readme",
)
GENERIC_IMPLEMENTATION_PATTERNS = (
    "add tests so it works",
    "change the code",
    "implement the feature",
    "make it work",
    "update the code",
    "works as expected",
)
VAGUE_ACCEPTANCE_PATTERNS = (
    "displays a message",
    "handles errors",
    "is implemented",
    "is updated",
    "passes tests",
    "shows a message",
    "the system displays a message",
    "updates the ui",
    "works as expected",
)
OBSERVABLE_TERMS = (
    "blocks",
    "creates",
    "deletes",
    "displays",
    "emits",
    "fails",
    "persists",
    "records",
    "redirects",
    "rejects",
    "renders",
    "returns",
    "saves",
    "shows",
    "stores",
    "updates",
    "validates",
    "when ",
    "given ",
    "then ",
)
USER_STORY_RE = re.compile(
    r"^\s*As\s+a[n]?\s+[^,]+,\s*I\s+want\s+.+,\s*so\s+that\s+.+\.\s*$",
    re.IGNORECASE | re.DOTALL,
)


def as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def acceptance_texts_from_items(items: Any) -> list[str]:
    texts: list[str] = []
    if not isinstance(items, list):
        return texts
    for item in items:
        if not isinstance(item, dict):
            continue
        narrative = item.get("narrative")
        if isinstance(narrative, dict):
            acceptance = narrative.get("Acceptance")
            if isinstance(acceptance, str) and acceptance.strip():
                texts.append(acceptance.strip())
        for child_key in ("items", "subItems"):
            texts.extend(acceptance_texts_from_items(item.get(child_key)))
    return texts


def item_has_acceptance(item: dict[str, Any]) -> bool:
    narrative = item.get("narrative")
    if isinstance(narrative, dict):
        value = narrative.get("Acceptance")
        if isinstance(value, str) and value.strip():
            return True
    for child_key in ("items", "subItems"):
        children = item.get(child_key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and item_has_acceptance(child):
                    return True
    return False


def items_have_acceptance(items: Any) -> bool:
    if not isinstance(items, list):
        return False
    return any(isinstance(item, dict) and item_has_acceptance(item) for item in items)


def item_has_traces(item: dict[str, Any]) -> bool:
    narrative = item.get("narrative")
    if isinstance(narrative, dict):
        value = narrative.get("Traces")
        if isinstance(value, str) and value.strip():
            return True
    for child_key in ("items", "subItems"):
        children = item.get(child_key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and item_has_traces(child):
                    return True
    return False


def missing_required_swarm_fields(swarm: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    for key in ("file_scope", "verify_commands", "expected_outputs"):
        if not as_str_list(swarm.get(key)):
            missing.append(f"plan.metadata.swarm.{key}")
    if "depends_on" not in swarm:
        missing.append("plan.metadata.swarm.depends_on")
    for key in ("conflict_group", "size", "file_scope_confidence", "model_tier"):
        value = swarm.get(key)
        if not isinstance(value, str) or not value.strip():
            missing.append(f"plan.metadata.swarm.{key}")
    return missing


def deprecated_subitems_issues(items: Any, prefix: str = "plan.items") -> list[str]:
    issues: list[str] = []

    def visit(children: Any, path: str) -> None:
        if not isinstance(children, list):
            return
        for index, item in enumerate(children):
            if not isinstance(item, dict):
                continue
            item_path = f"{path}[{index}]"
            if "subItems" in item:
                issues.append(f"{item_path}.subItems is deprecated; use items")
            visit(item.get("items"), f"{item_path}.items")
            visit(item.get("subItems"), f"{item_path}.subItems")

    visit(items, prefix)
    return issues


def story_quality_issues(
    *,
    title: str,
    description: str,
    implementation_plan: str,
    user_story: str,
    acceptance_texts: list[str],
    acceptance_count_justification: str,
    swarm: dict[str, Any],
    concurrent_ready: bool = True,
) -> list[str]:
    issues: list[str] = []
    if not USER_STORY_RE.match(user_story or ""):
        issues.append(
            "UserStory must match 'As a <role>, I want <capability>, so that <outcome>.'"
        )
    issues.extend(_description_issues(description))
    issues.extend(_implementation_plan_issues(implementation_plan))
    if not (2 <= len(acceptance_texts) <= 5) and not acceptance_count_justification.strip():
        issues.append("2-5 acceptance criteria required unless justified")

    normalized_title = _normalize(title)
    normalized_description = _normalize(description)
    for criterion in acceptance_texts:
        normalized = _normalize(criterion)
        lower = criterion.lower()
        if any(pattern in lower for pattern in PLACEHOLDER_ACCEPTANCE_PATTERNS):
            issues.append("placeholder acceptance criterion")
        if normalized and normalized in {normalized_title, normalized_description}:
            issues.append("acceptance criterion duplicates title or description")
        if any(pattern in lower for pattern in DOCS_ONLY_ACCEPTANCE_PATTERNS):
            issues.append("vague docs-only acceptance criterion")
        if _word_count(criterion) < 8 or any(
            pattern in lower for pattern in VAGUE_ACCEPTANCE_PATTERNS
        ):
            issues.append("acceptance criterion must describe specific observable behavior")
        if not _looks_observable(lower):
            issues.append("acceptance criterion must describe observable behavior")

    if concurrent_ready:
        issues.extend(_file_scope_issues(swarm))
        issues.extend(_verify_command_issues(swarm))
        if swarm.get("parallel_safe") is False:
            issues.append(
                "readiness=ready requires parallel_safe=true; use readiness=sequential "
                "or needs_refinement for non-concurrent work"
            )
        if swarm.get("file_scope_confidence") == "low":
            issues.append("readiness=ready requires file_scope_confidence above low")
    return _dedupe(issues)


def _file_scope_issues(swarm: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    for file_path in as_str_list(swarm.get("file_scope")):
        normalized = file_path.strip().strip("/")
        root = normalized.split("/", 1)[0]
        if (
            any(ch in normalized for ch in "*?[")
            or normalized in BROAD_FILE_SCOPE_ROOTS
            or file_path.rstrip("/") in BROAD_FILE_SCOPE_ROOTS
            or (root in BROAD_FILE_SCOPE_ROOTS and normalized in {root, f"{root}/*"})
        ):
            issues.append(f"broad file_scope is not swarm-ready: {file_path}")
    return issues


def _verify_command_issues(swarm: dict[str, Any]) -> list[str]:
    commands = [command.lower() for command in as_str_list(swarm.get("verify_commands"))]
    if len(commands) == 1 and _normalize_command(commands[0]) in GENERIC_VERIFY_COMMANDS:
        return [f"generic verify command is not swarm-ready: {commands[0]}"]
    return []


def _description_issues(description: str) -> list[str]:
    if not description.strip():
        return ["plan.narratives.Description is required"]
    if _sentence_count(description) < 2 or _word_count(description) < 20:
        return ["plan.narratives.Description must contain at least two concrete sentences"]
    return []


def _implementation_plan_issues(implementation_plan: str) -> list[str]:
    if not implementation_plan.strip():
        return ["plan.narratives.ImplementationPlan is required"]
    issues: list[str] = []
    if _step_count(implementation_plan) < 2 or _word_count(implementation_plan) < 20:
        issues.append(
            "plan.narratives.ImplementationPlan must contain at least two concrete steps"
        )
    lower = implementation_plan.lower()
    if any(pattern in lower for pattern in PLACEHOLDER_ACCEPTANCE_PATTERNS):
        issues.append("plan.narratives.ImplementationPlan must not be placeholder text")
    if any(pattern in lower for pattern in GENERIC_IMPLEMENTATION_PATTERNS) or not (
        any(term in lower for term in CODE_PATH_TERMS)
        and any(term in lower for term in VERIFY_EVIDENCE_TERMS)
    ):
        issues.append(
            "plan.narratives.ImplementationPlan must identify concrete code paths "
            "and verification evidence"
        )
    return issues


def _looks_observable(lower: str) -> bool:
    return any(term in lower for term in OBSERVABLE_TERMS)


def _sentence_count(value: str) -> int:
    return len([part for part in re.split(r"[.!?]+(?:\s+|$)", value.strip()) if part.strip()])


def _step_count(value: str) -> int:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    bullet_lines = [
        line
        for line in lines
        if re.match(r"^([-*]|\d+[.)])\s+", line)
    ]
    if len(bullet_lines) >= 2:
        return len(bullet_lines)
    return _sentence_count(value)


def _word_count(value: str) -> int:
    return len(re.findall(r"\b\w+\b", value))


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _normalize_command(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out
