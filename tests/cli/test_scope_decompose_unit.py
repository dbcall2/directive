"""In-process unit tests for the decomposition readiness layer.

The companion file ``tests/cli/test_scope_decompose.py`` drives the CLI through
``subprocess.run([sys.executable, ...])``. Coverage.py does not follow child
processes by default, so those integration tests barely register the script
bodies and leave ``scripts/scope_decompose.py`` and
``scripts/_vbrief_story_quality.py`` well below the
``[tool.coverage.report].fail_under = 85`` gate in ``pyproject.toml``.

These tests exercise the same public API surfaces directly, in-process, so
coverage.py credits every executed line. The subprocess-based integration
tests in ``tests/cli/test_scope_decompose.py`` are intentionally preserved
verbatim: they remain the CLI contract suite.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_scope_module() -> ModuleType:
    """Import ``scripts/scope_decompose.py`` as a real module.

    Mirrors the helper used by the CLI integration suite so coverage.py
    records the executed source lines, not a subprocess copy.
    """
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(
        "scope_decompose_unit_module",
        SCRIPTS_DIR / "scope_decompose.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_quality_module() -> ModuleType:
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(
        "vbrief_story_quality_unit_module",
        SCRIPTS_DIR / "_vbrief_story_quality.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def scope() -> ModuleType:
    return _load_scope_module()


@pytest.fixture(scope="module")
def quality() -> ModuleType:
    return _load_quality_module()


# ---------------------------------------------------------------------------
# Helpers (mirrors of the CLI-suite fixtures, kept self-contained on purpose)
# ---------------------------------------------------------------------------


def _write_json(path: Path, data: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _good_story(
    story_id: str = "story-auth-model",
    title: str = "Auth model",
    deps: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": story_id,
        "title": title,
        "description": (
            f"{title} persistence behavior stores user identity and session "
            "state for the authentication workflow. The story covers focused "
            "model changes plus matching unit tests for save and load."
        ),
        "implementation_plan": [
            (
                "Update the auth model persistence code so valid user payloads "
                "are saved through the existing model boundary."
            ),
            (
                "Add focused model tests for successful persistence and "
                "missing-record behavior using the auth model test fixture."
            ),
        ],
        "user_story": (
            "As an auth maintainer, I want persisted user records, "
            "so that login state survives requests."
        ),
        "acceptance": [
            (
                "Given a valid user payload, when the auth model saves it, "
                "then the user record persists."
            ),
            (
                "Given an existing user, when the auth model loads it, "
                "then the saved identity returns."
            ),
        ],
        "traces": ["FR-1"],
        "swarm": {
            "readiness": "ready",
            "parallel_safe": True,
            "file_scope": ["src/auth/model.ts", "tests/auth/model.test.ts"],
            "verify_commands": ["npm test -- auth/model"],
            "expected_outputs": ["auth model tests pass"],
            "depends_on": deps or [],
            "conflict_group": "auth",
            "size": "small",
            "file_scope_confidence": "high",
            "model_tier": "medium",
        },
    }


def _good_draft(*, output_dir: str | None = None, status: str | None = None) -> dict[str, Any]:
    draft: dict[str, Any] = {
        "stories": [
            _good_story(),
            _good_story(
                story_id="story-auth-routes",
                title="Auth routes",
                deps=["story-auth-model"],
            ),
        ]
    }
    # The second story's file_scope must differ from the first to stay narrow.
    draft["stories"][1]["swarm"]["file_scope"] = [
        "src/auth/routes.ts",
        "tests/auth/routes.test.ts",
    ]
    draft["stories"][1]["swarm"]["verify_commands"] = ["npm test -- auth/routes"]
    if output_dir is not None:
        draft["output_dir"] = output_dir
    if status is not None:
        draft["status"] = status
    return draft


def _good_parent() -> dict[str, Any]:
    return {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": "ip-1",
            "title": "IP-1: Auth",
            "status": "pending",
            "narratives": {
                "Acceptance": "Auth epic acceptance remains as context.",
                "Traces": "FR-1, IP-1",
            },
            "items": [],
            "metadata": {"kind": "phase", "dependencies": []},
            "references": [
                {
                    "uri": "specification.vbrief.json",
                    "type": "x-vbrief/plan",
                    "title": "Specification",
                    "TrustLevel": "internal",
                },
                {
                    "uri": "pending/2026-05-12-ip001-auth.vbrief.json#Acceptance",
                    "type": "x-vbrief/acceptance",
                    "title": "Parent Acceptance",
                    "TrustLevel": "internal",
                },
            ],
        },
    }


def _write_parent(project: Path, *, folder: str = "pending") -> Path:
    parent = copy.deepcopy(_good_parent())
    if folder != "pending":
        parent["plan"]["status"] = "running" if folder == "active" else folder
    return _write_json(
        project / "vbrief" / folder / "2026-05-12-ip001-auth.vbrief.json",
        parent,
    )


# ---------------------------------------------------------------------------
# _vbrief_story_quality.py: helpers and rule predicates
# ---------------------------------------------------------------------------


class TestQualityHelpers:
    def test_as_str_list_variants(self, quality: ModuleType) -> None:
        assert quality.as_str_list(None) == []
        assert quality.as_str_list("") == []
        assert quality.as_str_list("  ") == []
        assert quality.as_str_list("alpha") == ["alpha"]
        assert quality.as_str_list(["a", "", " b ", 3]) == ["a", "b", "3"]
        # Non-string / non-list values return empty.
        assert quality.as_str_list({"a": 1}) == []
        assert quality.as_str_list(42) == []

    def test_acceptance_texts_from_items_walks_nested(self, quality: ModuleType) -> None:
        items = [
            {
                "narrative": {"Acceptance": "Top-level acceptance text"},
                "items": [
                    {
                        "narrative": {"Acceptance": "Child acceptance text"},
                        "subItems": [
                            {"narrative": {"Acceptance": "Grandchild acceptance text"}},
                        ],
                    }
                ],
            },
            "not-a-dict",
            {"narrative": "not-a-dict"},
            {"narrative": {"Acceptance": "   "}},
        ]
        result = quality.acceptance_texts_from_items(items)
        assert result == [
            "Top-level acceptance text",
            "Child acceptance text",
            "Grandchild acceptance text",
        ]
        assert quality.acceptance_texts_from_items("not-a-list") == []

    def test_item_has_acceptance_and_traces(self, quality: ModuleType) -> None:
        assert quality.item_has_acceptance({"narrative": {"Acceptance": "yes"}}) is True
        assert (
            quality.item_has_acceptance(
                {
                    "items": [
                        {"narrative": {"Acceptance": "deep"}},
                    ]
                }
            )
            is True
        )
        assert (
            quality.item_has_acceptance(
                {
                    "subItems": [
                        {"narrative": {"Acceptance": "deep"}},
                    ]
                }
            )
            is True
        )
        assert quality.item_has_acceptance({"narrative": {"Acceptance": ""}}) is False
        assert quality.item_has_acceptance({"items": "not-a-list"}) is False
        assert quality.item_has_acceptance({}) is False

        assert quality.item_has_traces({"narrative": {"Traces": "FR-1"}}) is True
        assert (
            quality.item_has_traces(
                {"items": [{"narrative": {"Traces": "FR-1"}}]}
            )
            is True
        )
        assert (
            quality.item_has_traces(
                {"subItems": [{"narrative": {"Traces": "FR-1"}}]}
            )
            is True
        )
        assert quality.item_has_traces({}) is False

    def test_items_have_acceptance(self, quality: ModuleType) -> None:
        assert quality.items_have_acceptance("not-list") is False
        assert quality.items_have_acceptance([]) is False
        assert quality.items_have_acceptance([{"no": "acc"}]) is False
        assert (
            quality.items_have_acceptance(
                [{"narrative": {"Acceptance": "yes"}}]
            )
            is True
        )

    def test_missing_required_swarm_fields(self, quality: ModuleType) -> None:
        # Empty swarm -> every required field reported.
        missing = quality.missing_required_swarm_fields({})
        expected = {
            "plan.metadata.swarm.file_scope",
            "plan.metadata.swarm.verify_commands",
            "plan.metadata.swarm.expected_outputs",
            "plan.metadata.swarm.depends_on",
            "plan.metadata.swarm.conflict_group",
            "plan.metadata.swarm.size",
            "plan.metadata.swarm.file_scope_confidence",
            "plan.metadata.swarm.model_tier",
        }
        assert set(missing) == expected

        # depends_on present (even empty) drops only the depends_on entry.
        partial = quality.missing_required_swarm_fields({"depends_on": []})
        assert "plan.metadata.swarm.depends_on" not in partial

        # All required fields present and well-typed -> no issues.
        full = {
            "file_scope": ["src/x.ts"],
            "verify_commands": ["npm test"],
            "expected_outputs": ["passes"],
            "depends_on": [],
            "conflict_group": "auth",
            "size": "small",
            "file_scope_confidence": "high",
            "model_tier": "medium",
        }
        assert quality.missing_required_swarm_fields(full) == []

    def test_deprecated_subitems_issues(self, quality: ModuleType) -> None:
        assert quality.deprecated_subitems_issues(None) == []
        items = [
            {
                "items": [
                    "not-a-dict",
                    {"subItems": []},
                ],
                "subItems": [{"subItems": []}],
            },
            "not-a-dict",
        ]
        issues = quality.deprecated_subitems_issues(items)
        assert any("subItems is deprecated" in issue for issue in issues)
        # The deprecated path is reported with the dotted path that includes
        # the index of the offending item.
        assert any(".items[1].subItems is deprecated" in issue for issue in issues)


class TestStoryQualityIssues:
    """Drive ``story_quality_issues`` through every failure mode."""

    @pytest.fixture
    def base_kwargs(self) -> dict[str, Any]:
        return {
            "title": "Auth model",
            "description": (
                "Auth model persistence stores user identity and session "
                "state. The story covers focused model changes plus matching "
                "unit tests for save and load behavior."
            ),
            "implementation_plan": (
                "- Update the src/auth model persistence code so valid "
                "payloads are saved through the model boundary.\n"
                "- Add focused tests for successful persistence and a "
                "missing-record fixture in tests/auth/model."
            ),
            "user_story": (
                "As an auth maintainer, I want persisted user records, "
                "so that login state survives requests."
            ),
            "acceptance_texts": [
                (
                    "Given a valid user payload, when the auth model saves "
                    "it, then the user record persists."
                ),
                (
                    "Given an existing user, when the auth model loads it, "
                    "then the saved identity returns."
                ),
            ],
            "acceptance_count_justification": "",
            "swarm": {
                "file_scope": ["src/auth/model.ts", "tests/auth/model.test.ts"],
                "verify_commands": ["npm test -- auth/model"],
                "parallel_safe": True,
                "file_scope_confidence": "high",
            },
            "concurrent_ready": True,
        }

    def test_happy_path_has_no_issues(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        assert quality.story_quality_issues(**base_kwargs) == []

    def test_user_story_format_required(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["user_story"] = "Just build the thing."
        issues = quality.story_quality_issues(**base_kwargs)
        assert any("UserStory must match" in issue for issue in issues)

    def test_description_too_short(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["description"] = "Persist auth records."
        issues = quality.story_quality_issues(**base_kwargs)
        assert any("Description must contain at least two" in issue for issue in issues)

    def test_description_missing(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["description"] = ""
        issues = quality.story_quality_issues(**base_kwargs)
        assert "plan.narratives.Description is required" in issues

    def test_implementation_plan_missing(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["implementation_plan"] = ""
        issues = quality.story_quality_issues(**base_kwargs)
        assert "plan.narratives.ImplementationPlan is required" in issues

    def test_implementation_plan_too_short(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["implementation_plan"] = "Update model code."
        issues = quality.story_quality_issues(**base_kwargs)
        assert any(
            "ImplementationPlan must contain at least two" in issue for issue in issues
        )

    def test_implementation_plan_generic(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["implementation_plan"] = (
            "- Update the code so the feature is implemented in the application.\n"
            "- Add tests so it works as expected for users."
        )
        issues = quality.story_quality_issues(**base_kwargs)
        assert any(
            "concrete code paths" in issue for issue in issues
        )

    def test_implementation_plan_placeholder(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["implementation_plan"] = (
            "- TODO refine from parent scope\n- TBD\n- placeholder"
        )
        issues = quality.story_quality_issues(**base_kwargs)
        assert any(
            "ImplementationPlan must not be placeholder text" in issue for issue in issues
        )

    def test_acceptance_count_outside_range(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        # Provide a single acceptance with no justification.
        base_kwargs["acceptance_texts"] = [
            "Given a valid payload, when auth saves it, then it persists."
        ]
        issues = quality.story_quality_issues(**base_kwargs)
        assert "2-5 acceptance criteria required unless justified" in issues

    def test_acceptance_count_justified(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["acceptance_texts"] = [
            "Given a valid payload, when auth saves it, then it persists."
        ]
        base_kwargs["acceptance_count_justification"] = (
            "A single acceptance criterion is sufficient because the story "
            "only exposes one observable outcome."
        )
        issues = quality.story_quality_issues(**base_kwargs)
        assert "2-5 acceptance criteria required unless justified" not in issues

    @pytest.mark.parametrize(
        ("criterion", "expected_fragment"),
        [
            ("to refine from parent scope", "placeholder acceptance criterion"),
            ("docs updated for the new behavior", "docs-only acceptance criterion"),
            ("It is updated.", "specific observable behavior"),
            (
                # No OBSERVABLE_TERMS, no vague patterns, >=8 words: hits only
                # the "must describe observable behavior" rule.
                "A user with valid credentials logs into the system successfully today.",
                "acceptance criterion must describe observable behavior",
            ),
        ],
    )
    def test_acceptance_quality_patterns(
        self,
        quality: ModuleType,
        base_kwargs: dict[str, Any],
        criterion: str,
        expected_fragment: str,
    ) -> None:
        base_kwargs["acceptance_texts"] = [
            criterion,
            (
                "Given an existing user, when the auth model loads it, "
                "then the saved identity returns."
            ),
        ]
        issues = quality.story_quality_issues(**base_kwargs)
        assert any(expected_fragment in issue for issue in issues), issues

    def test_acceptance_duplicates_title(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        title = base_kwargs["title"]
        base_kwargs["acceptance_texts"] = [
            title,
            (
                "Given an existing user, when the auth model loads it, "
                "then the saved identity returns."
            ),
        ]
        issues = quality.story_quality_issues(**base_kwargs)
        assert "acceptance criterion duplicates title or description" in issues

    @pytest.mark.parametrize(
        ("file_scope", "expected_fragment"),
        [
            (["backend"], "broad file_scope"),
            (["backend/**"], "broad file_scope"),
            (["src/*.ts"], "broad file_scope"),
            (["docs"], "broad file_scope"),
            (["vbrief/"], "broad file_scope"),
        ],
    )
    def test_broad_file_scope(
        self,
        quality: ModuleType,
        base_kwargs: dict[str, Any],
        file_scope: list[str],
        expected_fragment: str,
    ) -> None:
        base_kwargs["swarm"] = dict(base_kwargs["swarm"], file_scope=file_scope)
        issues = quality.story_quality_issues(**base_kwargs)
        assert any(expected_fragment in issue for issue in issues), issues

    @pytest.mark.parametrize(
        "command",
        ["task check", "pytest", "go test ./...", "npm test", "npm run test", "cargo test"],
    )
    def test_generic_verify_command_rejected(
        self, quality: ModuleType, base_kwargs: dict[str, Any], command: str
    ) -> None:
        base_kwargs["swarm"] = dict(base_kwargs["swarm"], verify_commands=[command])
        issues = quality.story_quality_issues(**base_kwargs)
        assert any("generic verify command" in issue for issue in issues), issues

    def test_parallel_safe_false_blocks_ready(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["swarm"] = dict(base_kwargs["swarm"], parallel_safe=False)
        issues = quality.story_quality_issues(**base_kwargs)
        assert any("parallel_safe=true" in issue for issue in issues)

    def test_file_scope_confidence_low_blocks_ready(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        base_kwargs["swarm"] = dict(base_kwargs["swarm"], file_scope_confidence="low")
        issues = quality.story_quality_issues(**base_kwargs)
        assert any(
            "file_scope_confidence above low" in issue for issue in issues
        )

    def test_non_concurrent_skips_swarm_rules(
        self, quality: ModuleType, base_kwargs: dict[str, Any]
    ) -> None:
        # Non-concurrent stories should not be blocked by swarm-only rules.
        base_kwargs["swarm"] = dict(
            base_kwargs["swarm"],
            parallel_safe=False,
            file_scope_confidence="low",
            file_scope=["backend"],
            verify_commands=["task check"],
        )
        base_kwargs["concurrent_ready"] = False
        issues = quality.story_quality_issues(**base_kwargs)
        assert not any("broad file_scope" in issue for issue in issues)
        assert not any("generic verify command" in issue for issue in issues)
        assert not any("parallel_safe=true" in issue for issue in issues)
        assert not any(
            "file_scope_confidence above low" in issue for issue in issues
        )


# ---------------------------------------------------------------------------
# scope_decompose.py: pure helpers
# ---------------------------------------------------------------------------


class TestScopeHelpers:
    def test_load_json_round_trip(self, scope: ModuleType, tmp_path: Path) -> None:
        path = tmp_path / "doc.json"
        path.write_text(json.dumps({"a": 1}), encoding="utf-8")
        assert scope._load_json(path) == {"a": 1}

    def test_load_json_invalid_payload(self, scope: ModuleType, tmp_path: Path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("not-json", encoding="utf-8")
        with pytest.raises(scope.DecompositionError, match="invalid JSON"):
            scope._load_json(path)

    def test_load_json_non_object_payload(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        path = tmp_path / "list.json"
        path.write_text("[1, 2, 3]", encoding="utf-8")
        with pytest.raises(scope.DecompositionError, match="expected a JSON object"):
            scope._load_json(path)

    def test_resolve_path_variants(self, scope: ModuleType, tmp_path: Path) -> None:
        assert scope._resolve_path(tmp_path, None) is None
        assert scope._resolve_path(tmp_path, "") is None
        rel = scope._resolve_path(tmp_path, "vbrief/pending")
        assert rel == tmp_path / "vbrief" / "pending"
        absolute = (tmp_path / "vbrief" / "pending").resolve()
        assert scope._resolve_path(tmp_path, str(absolute)) == Path(str(absolute))

    def test_rel_to_vbrief_outside(self, scope: ModuleType, tmp_path: Path) -> None:
        vbrief = tmp_path / "vbrief"
        vbrief.mkdir()
        other = tmp_path / "other.json"
        other.write_text("{}", encoding="utf-8")
        with pytest.raises(scope.DecompositionError, match="path must be inside"):
            scope._rel_to_vbrief(vbrief, other)

    def test_default_status_for_folder(self, scope: ModuleType, tmp_path: Path) -> None:
        for name, expected in (
            ("proposed", "proposed"),
            ("pending", "pending"),
            ("active", "running"),
            ("completed", "completed"),
            ("cancelled", "cancelled"),
            ("unknown", "pending"),
        ):
            folder = tmp_path / name
            assert scope._default_status_for_folder(folder) == expected

    def test_normalize_status(self, scope: ModuleType) -> None:
        assert scope._normalize_status(None, "pending") == "pending"
        assert scope._normalize_status(" Active ", "pending") == "active"
        # Empty/whitespace-only falls back to default.
        assert scope._normalize_status("   ", "running") == "running"

    def test_story_specs_variants(self, scope: ModuleType) -> None:
        # Dict-of-stories shape collapses to a list.
        specs = scope._story_specs(
            {"stories": {"a": {"id": "a"}, "b": {"id": "b"}}}
        )
        ids = sorted(spec["id"] for spec in specs)
        assert ids == ["a", "b"]
        # Children key fallback.
        specs = scope._story_specs({"children": [{"id": "c"}]})
        assert specs[0]["id"] == "c"
        # Missing stories raises.
        with pytest.raises(scope.DecompositionError, match="stories array"):
            scope._story_specs({"stories": "nope"})
        with pytest.raises(scope.DecompositionError, match="must be an object"):
            scope._story_specs({"stories": ["not-a-dict"]})

    def test_story_id_fallbacks(self, scope: ModuleType) -> None:
        assert scope._story_id({"id": "alpha"}, 1) == "alpha"
        assert scope._story_id({"story_id": "beta"}, 1) == "beta"
        assert scope._story_id({"key": "gamma"}, 1) == "gamma"
        assert scope._story_id({"title": "My Title"}, 1) == "my-title"
        assert scope._story_id({}, 4) == "story-4"
        # Whitespace id falls through to title.
        assert scope._story_id({"id": "   ", "title": "Hello"}, 1) == "hello"

    def test_swarm_meta_promotes_top_level_keys(self, scope: ModuleType) -> None:
        story = {
            "swarm": {"size": "small"},
            "readiness": "ready",
            "parallel_safe": True,
            "file_scope": ["src/x.ts"],
            "verify_commands": ["npm test"],
            "expected_outputs": ["ok"],
            "depends_on": [],
            "conflict_group": "auth",
            "file_scope_confidence": "high",
            "model_tier": "medium",
            "missing_traces_justification": ["because"],
        }
        swarm = scope._swarm_meta(story)
        assert swarm["readiness"] == "ready"
        assert swarm["size"] == "small"
        assert swarm["missing_traces_justification"] == ["because"]

    def test_swarm_meta_uses_metadata_swarm(self, scope: ModuleType) -> None:
        story = {"metadata": {"swarm": {"size": "tiny"}}}
        assert scope._swarm_meta(story)["size"] == "tiny"

    def test_swarm_meta_handles_invalid_shapes(self, scope: ModuleType) -> None:
        assert scope._swarm_meta({"swarm": "nope"}) == {}
        assert scope._swarm_meta({"metadata": "nope"}) == {}

    def test_story_has_traces_sources(self, scope: ModuleType) -> None:
        # narratives.Traces present.
        assert (
            scope._story_has_traces(
                {"narratives": {"Traces": "FR-1"}}, [], {}
            )
            is True
        )
        # Top-level traces list.
        assert scope._story_has_traces({"traces": ["FR-1"]}, [], {}) is True
        # Item-level traces narrative.
        assert (
            scope._story_has_traces(
                {},
                [{"narrative": {"Traces": "FR-1"}}],
                {},
            )
            is True
        )
        # Missing traces justification on swarm.
        assert (
            scope._story_has_traces(
                {}, [], {"missing_traces_justification": ["because"]}
            )
            is True
        )
        # Spec-section reference.
        assert (
            scope._story_has_traces(
                {
                    "references": [
                        {"type": "x-vbrief/spec-section", "uri": "spec#x"}
                    ]
                },
                [],
                {},
            )
            is True
        )
        # None of the above.
        assert scope._story_has_traces({}, [], {}) is False

    def test_story_description_implementation_user_story(
        self, scope: ModuleType
    ) -> None:
        # narratives win.
        assert (
            scope._story_description(
                {"narratives": {"Description": "  hello "}}
            )
            == "hello"
        )
        # Falls back to description / summary.
        assert scope._story_description({"summary": "summary text"}) == "summary text"
        assert scope._story_description({}) == ""

        # ImplementationPlan: narratives, key, list join.
        assert (
            scope._story_implementation_plan(
                {"narratives": {"ImplementationPlan": "step"}}
            )
            == "step"
        )
        assert (
            scope._story_implementation_plan(
                {"implementation_plan": ["one", "two"]}
            )
            == "one\ntwo"
        )
        assert scope._story_implementation_plan({}) == ""

        # UserStory.
        assert (
            scope._story_user_story({"narratives": {"UserStory": "story"}})
            == "story"
        )
        assert scope._story_user_story({"UserStory": "alt"}) == "alt"
        assert scope._story_user_story({}) == ""

    def test_acceptance_count_justification_sources(self, scope: ModuleType) -> None:
        assert (
            scope._acceptance_count_justification(
                {"acceptance_criteria_justification": "story-level"},
                {},
            )
            == "story-level"
        )
        assert (
            scope._acceptance_count_justification(
                {},
                {"acceptance_criteria_justification": "swarm-level"},
            )
            == "swarm-level"
        )
        assert (
            scope._acceptance_count_justification(
                {"narratives": {"AcceptanceJustification": "narrative-level"}},
                {},
            )
            == "narrative-level"
        )
        assert scope._acceptance_count_justification({}, {}) == ""

    def test_items_from_story_uses_existing_items(self, scope: ModuleType) -> None:
        items = [{"id": "x", "narrative": {"Acceptance": "ok"}}]
        assert scope._items_from_story("story-x", {"items": items}) is items

    def test_items_from_story_generates_from_acceptance(self, scope: ModuleType) -> None:
        story = {
            "acceptance": [
                "Given a payload, when saved, then it persists.",
                "Given a payload, when loaded, then it returns.",
            ],
            "traces": ["FR-1", "FR-2"],
        }
        generated = scope._items_from_story("story-x", story)
        assert len(generated) == 2
        first = generated[0]
        assert first["id"] == "story-x-a1"
        assert first["narrative"]["Acceptance"].startswith("Given a payload")
        assert first["narrative"]["Traces"] == "FR-1, FR-2"

    def test_items_from_story_uses_acceptance_items_fallback(
        self, scope: ModuleType
    ) -> None:
        story = {
            "acceptance_items": [
                "Given a payload, when saved, then it persists.",
            ],
        }
        generated = scope._items_from_story("story-x", story)
        assert generated[0]["id"] == "story-x-a1"

    def test_validate_dag_unknown_dep_and_cycle(self, scope: ModuleType) -> None:
        # Unknown dep.
        with pytest.raises(scope.DecompositionError, match="unknown story"):
            scope._validate_dag(["a"], {"a": ["b"]})

        # Cycle detection.
        with pytest.raises(scope.DecompositionError, match="dependency cycle"):
            scope._validate_dag(
                ["a", "b", "c"],
                {"a": ["b"], "b": ["c"], "c": ["b"]},
            )

        # Self-cycle.
        with pytest.raises(scope.DecompositionError, match="dependency cycle"):
            scope._validate_dag(["a"], {"a": ["a"]})

        # Valid DAG returns None.
        assert (
            scope._validate_dag(
                ["a", "b"], {"a": ["b"], "b": []}
            )
            is None
        )

    def test_validate_draft_duplicate_story_id(self, scope: ModuleType) -> None:
        stories = [_good_story(), _good_story()]
        with pytest.raises(scope.DecompositionError, match="duplicate story id"):
            scope.validate_draft(stories)

    def test_validate_draft_happy_path_returns_story_ids(
        self, scope: ModuleType
    ) -> None:
        stories = [
            _good_story(),
            _good_story(
                story_id="story-auth-routes",
                title="Auth routes",
                deps=["story-auth-model"],
            ),
        ]
        stories[1]["swarm"]["file_scope"] = [
            "src/auth/routes.ts",
            "tests/auth/routes.test.ts",
        ]
        stories[1]["swarm"]["verify_commands"] = ["npm test -- auth/routes"]
        assert scope.validate_draft(stories) == [
            "story-auth-model",
            "story-auth-routes",
        ]

    def test_validate_draft_reports_missing_required_fields(
        self, scope: ModuleType
    ) -> None:
        stories = [
            {
                "id": "story-bad",
                "title": "Bad story",
                "swarm": {"readiness": "ready", "parallel_safe": True},
            }
        ]
        with pytest.raises(scope.DecompositionError) as excinfo:
            scope.validate_draft(stories)
        message = str(excinfo.value)
        assert "plan.items" in message
        assert "file_scope" in message
        assert "verify_commands" in message

    def test_validate_draft_rejects_missing_id_and_title(
        self, scope: ModuleType
    ) -> None:
        story = _good_story()
        story.pop("id")
        story.pop("title")
        with pytest.raises(scope.DecompositionError) as excinfo:
            scope.validate_draft([story])
        assert "id" in str(excinfo.value)
        assert "title" in str(excinfo.value)

    def test_validate_draft_rejects_invalid_readiness(
        self, scope: ModuleType
    ) -> None:
        story = _good_story()
        story["swarm"]["readiness"] = "nope"
        with pytest.raises(scope.DecompositionError, match="readiness"):
            scope.validate_draft([story])

    def test_validate_draft_rejects_missing_parallel_safe(
        self, scope: ModuleType
    ) -> None:
        story = _good_story()
        story["swarm"].pop("parallel_safe")
        with pytest.raises(scope.DecompositionError, match="parallel_safe"):
            scope.validate_draft([story])

    def test_validate_draft_rejects_missing_traces(self, scope: ModuleType) -> None:
        story = _good_story()
        story.pop("traces")
        with pytest.raises(
            scope.DecompositionError, match="Traces or missing_traces_justification"
        ):
            scope.validate_draft([story])

    def test_normalize_references_filters_non_dicts(self, scope: ModuleType) -> None:
        refs = [
            {"uri": "u", "type": "x-vbrief/plan", "title": "T"},
            "not-a-dict",
            {"uri": "u2", "type": "x-vbrief/github-issue", "title": "G"},
        ]
        normalized = scope._normalize_references(refs)
        assert [ref["TrustLevel"] for ref in normalized] == ["internal", "external"]
        # Non-list input returns empty.
        assert scope._normalize_references("nope") == []

    def test_child_provenance_references_strips_acceptance(
        self, scope: ModuleType
    ) -> None:
        refs = [
            {"uri": "u", "type": "x-vbrief/plan", "title": "T"},
            {"uri": "u2", "type": "x-vbrief/acceptance", "title": "AC"},
        ]
        provenance = scope._child_provenance_references(refs)
        assert len(provenance) == 1
        assert provenance[0]["type"] == "x-vbrief/plan"

    def test_dedupe_references_collapses_duplicates(self, scope: ModuleType) -> None:
        refs = [
            {"uri": "u", "type": "x-vbrief/plan", "title": "T"},
            {"uri": "u", "type": "x-vbrief/plan", "title": "T"},
            {"uri": "v", "type": "x-vbrief/plan", "title": "T2"},
        ]
        assert len(scope._dedupe_references(refs)) == 2

    def test_story_narratives_merges_draft_keys(self, scope: ModuleType) -> None:
        narratives = scope._story_narratives(
            {
                "narratives": {"Description": "explicit description"},
                "summary": "ignored because Description already set",
                "implementation_plan": ["step one", "step two"],
                "user_story": "As a user, I want X, so that Y.",
                "traces": ["FR-1", "FR-2"],
            }
        )
        assert narratives["Description"] == "explicit description"
        assert narratives["ImplementationPlan"] == "step one\nstep two"
        assert narratives["UserStory"].startswith("As a user")
        assert narratives["Traces"] == "FR-1, FR-2"

    def test_story_narratives_uses_summary_when_description_missing(
        self, scope: ModuleType
    ) -> None:
        narratives = scope._story_narratives({"summary": "summary text"})
        assert narratives["Description"] == "summary text"

    def test_child_filename_uses_existing(self, scope: ModuleType) -> None:
        assert (
            scope._child_filename(
                {"filename": "custom.vbrief.json"}, "story-x", "Title", "2026-01-01"
            )
            == "custom.vbrief.json"
        )

    def test_child_filename_generates(self, scope: ModuleType) -> None:
        assert (
            scope._child_filename({}, "story-x", "My Title", "2026-01-01")
            == "2026-01-01-my-title.vbrief.json"
        )
        # Empty title falls back to slugified id.
        assert (
            scope._child_filename({}, "story-x", "", "2026-01-01")
            == "2026-01-01-story-x.vbrief.json"
        )

    def test_build_child_vbrief_shape(self, scope: ModuleType) -> None:
        story = _good_story()
        parent = _good_parent()
        child = scope._build_child_vbrief(
            story=story,
            story_id="story-auth-model",
            story_index=1,
            parent=parent,
            parent_rel="pending/parent.vbrief.json",
            status="pending",
        )
        assert child["plan"]["id"] == "story-auth-model"
        assert child["plan"]["planRef"] == "pending/parent.vbrief.json"
        assert child["plan"]["metadata"]["kind"] == "story"
        assert child["plan"]["metadata"]["swarm"]["readiness"] == "ready"
        # The acceptance-typed parent reference is filtered out of the
        # child's references; only the plan-typed one remains.
        assert all(
            ref.get("type") != "x-vbrief/acceptance"
            for ref in child["plan"]["references"]
        )


# ---------------------------------------------------------------------------
# scope_decompose.apply_decomposition: end-to-end in-process
# ---------------------------------------------------------------------------


class TestApplyDecomposition:
    def test_check_only_returns_actions(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        actions = scope.apply_decomposition(
            project_root=tmp_path,
            parent_path=parent,
            draft_path=draft,
            check_only=True,
            date="2026-05-12",
        )
        assert actions[0].startswith("VALIDATED 2 story")
        assert any(action.startswith("CHECK pending/") for action in actions)
        # Nothing was written.
        assert not list(
            (tmp_path / "vbrief" / "pending").glob("2026-05-12-auth-*.vbrief.json")
        )

    def test_apply_writes_children_and_updates_parent(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        actions = scope.apply_decomposition(
            project_root=tmp_path,
            parent_path=parent,
            draft_path=draft,
            check_only=False,
            date="2026-05-12",
        )
        assert actions[-1].endswith("references")
        children = sorted(
            (tmp_path / "vbrief" / "pending").glob("2026-05-12-auth-*.vbrief.json")
        )
        assert len(children) == 2
        updated = json.loads(parent.read_text(encoding="utf-8"))
        plan_refs = [
            ref for ref in updated["plan"]["references"] if ref.get("type") == "x-vbrief/plan"
        ]
        # Both child stories appended, plus the original Specification ref.
        assert len(plan_refs) >= 3

    def test_apply_rejects_existing_child(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        _write_json(
            tmp_path / "vbrief" / "pending" / "2026-05-12-auth-model.vbrief.json",
            {"existing": True},
        )
        with pytest.raises(
            scope.DecompositionError, match="overwriting is not supported"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=False,
                date="2026-05-12",
            )

    def test_apply_rejects_output_dir_outside_vbrief(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        outside = (tmp_path / "outside" / "pending").resolve()
        draft = _write_json(
            tmp_path / "decomp.json",
            _good_draft(output_dir=str(outside)),
        )
        with pytest.raises(
            scope.DecompositionError, match="output_dir must be inside vbrief/"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=True,
                date="2026-05-12",
            )

    def test_apply_rejects_non_lifecycle_output_dir(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(
            tmp_path / "decomp.json",
            _good_draft(output_dir="vbrief/scratch"),
        )
        with pytest.raises(
            scope.DecompositionError, match="vbrief lifecycle folder"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=True,
                date="2026-05-12",
            )

    def test_apply_rejects_active_output_dir(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(
            tmp_path / "decomp.json",
            _good_draft(output_dir="vbrief/active"),
        )
        with pytest.raises(
            scope.DecompositionError, match="must not be vbrief/active"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=True,
                date="2026-05-12",
            )

    def test_apply_rejects_active_draft_status(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(
            tmp_path / "decomp.json",
            _good_draft(status=" Active "),
        )
        with pytest.raises(
            scope.DecompositionError,
            match="decomposition cannot create active/running",
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=True,
                date="2026-05-12",
            )

    def test_apply_rejects_running_child_status(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent = _write_parent(tmp_path)
        draft_data = _good_draft()
        draft_data["stories"][0]["status"] = "running"
        draft = _write_json(tmp_path / "decomp.json", draft_data)
        with pytest.raises(
            scope.DecompositionError, match="story-auth-model"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=True,
                date="2026-05-12",
            )

    def test_apply_rejects_parent_plan_metadata_not_object(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent_data = _good_parent()
        parent_data["plan"]["metadata"] = "phase"
        parent = _write_json(
            tmp_path / "vbrief" / "pending" / "2026-05-12-ip001-auth.vbrief.json",
            parent_data,
        )
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        with pytest.raises(
            scope.DecompositionError, match="plan.metadata must be an object"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=False,
                date="2026-05-12",
            )

    def test_apply_rejects_parent_plan_not_object(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent_data = _good_parent()
        parent_data["plan"] = "not-an-object"
        parent = _write_json(
            tmp_path / "vbrief" / "pending" / "2026-05-12-ip001-auth.vbrief.json",
            parent_data,
        )
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        with pytest.raises(
            scope.DecompositionError, match="plan must be an object"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=False,
                date="2026-05-12",
            )

    def test_apply_rejects_parent_references_not_list(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        parent_data = _good_parent()
        parent_data["plan"]["references"] = "nope"
        parent = _write_json(
            tmp_path / "vbrief" / "pending" / "2026-05-12-ip001-auth.vbrief.json",
            parent_data,
        )
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        with pytest.raises(
            scope.DecompositionError, match="plan.references must be an array"
        ):
            scope.apply_decomposition(
                project_root=tmp_path,
                parent_path=parent,
                draft_path=draft,
                check_only=False,
                date="2026-05-12",
            )

    def test_apply_seeds_missing_parent_plan_and_metadata(
        self, scope: ModuleType, tmp_path: Path
    ) -> None:
        # Parent missing plan entirely -- apply_decomposition seeds it.
        parent_data: dict[str, Any] = {"vBRIEFInfo": {"version": "0.6"}}
        parent = _write_json(
            tmp_path / "vbrief" / "pending" / "2026-05-12-ip001-auth.vbrief.json",
            parent_data,
        )
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        scope.apply_decomposition(
            project_root=tmp_path,
            parent_path=parent,
            draft_path=draft,
            check_only=False,
            date="2026-05-12",
        )
        updated = json.loads(parent.read_text(encoding="utf-8"))
        assert isinstance(updated["plan"], dict)
        assert isinstance(updated["plan"]["metadata"], dict)
        assert updated["plan"]["metadata"]["kind"] == "epic"
        assert any(
            ref.get("type") == "x-vbrief/plan"
            for ref in updated["plan"]["references"]
        )


# ---------------------------------------------------------------------------
# scope_decompose.main: CLI dispatch
# ---------------------------------------------------------------------------


class TestMainCLI:
    def test_main_check_with_no_args_succeeds(
        self,
        scope: ModuleType,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        rc = scope.main(["--check", "--project-root", str(tmp_path)])
        assert rc == 0
        captured = capsys.readouterr()
        assert "no decomposition draft" in captured.out

    def test_main_missing_args_errors(
        self,
        scope: ModuleType,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        rc = scope.main(["--project-root", str(tmp_path)])
        assert rc == 2
        captured = capsys.readouterr()
        assert "parent path and --draft are required" in captured.err

    def test_main_missing_parent_file(
        self,
        scope: ModuleType,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        rc = scope.main(
            [
                "missing-parent.vbrief.json",
                "--draft",
                str(draft),
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == 2
        captured = capsys.readouterr()
        assert "parent vBRIEF not found" in captured.err

    def test_main_missing_draft_file(
        self,
        scope: ModuleType,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        parent = _write_parent(tmp_path)
        rc = scope.main(
            [
                str(parent),
                "--draft",
                str(tmp_path / "does-not-exist.json"),
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == 2
        captured = capsys.readouterr()
        assert "decomposition draft not found" in captured.err

    def test_main_success_prints_actions(
        self,
        scope: ModuleType,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        parent = _write_parent(tmp_path)
        draft = _write_json(tmp_path / "decomp.json", _good_draft())
        rc = scope.main(
            [
                str(parent),
                "--draft",
                str(draft),
                "--date",
                "2026-05-12",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == 0
        captured = capsys.readouterr()
        assert "VALIDATED 2 story" in captured.out

    def test_main_translates_decomposition_error_to_exit_1(
        self,
        scope: ModuleType,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        parent = _write_parent(tmp_path)
        draft_data = _good_draft()
        draft_data["stories"][0]["swarm"]["file_scope"] = ["backend"]  # broad scope
        draft = _write_json(tmp_path / "decomp.json", draft_data)
        rc = scope.main(
            [
                str(parent),
                "--draft",
                str(draft),
                "--check",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == 1
        captured = capsys.readouterr()
        assert "broad file_scope" in captured.err
