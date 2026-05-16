from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "scope_decompose.py"


def _load_scope_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("scope_decompose_script", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_json(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _parent(project: Path, folder: str = "pending") -> Path:
    return _write_json(
        project / "vbrief" / folder / "2026-05-12-ip001-auth.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": "ip-1",
                "title": "IP-1: Auth",
                "status": "pending" if folder == "pending" else "running",
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
                    }
                ],
            },
        },
    )


def _draft(project: Path, *, cycle: bool = False, output_dir: str | None = None) -> Path:
    stories = [
        {
            "id": "story-auth-model",
            "title": "Auth model",
            "description": (
                "Persisted auth model behavior stores user identity and session state for the "
                "authentication workflow. The story covers focused model changes plus matching "
                "unit tests for save and load behavior."
            ),
            "implementation_plan": [
                (
                    "Update the auth model persistence code so valid user payloads are saved "
                    "and loaded through the existing model boundary."
                ),
                (
                    "Add focused model tests for successful persistence and missing-record "
                    "behavior using the auth model test fixture."
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
                "depends_on": ["story-auth-routes"] if cycle else [],
                "conflict_group": "auth",
                "size": "small",
                "file_scope_confidence": "high",
                "model_tier": "medium",
            },
        },
        {
            "id": "story-auth-routes",
            "title": "Auth routes",
            "description": (
                "Auth route behavior turns credential checks into API responses for session "
                "creation. The story stays within route handling and focused route tests so it "
                "can run after the auth model contract is stable."
            ),
            "implementation_plan": [
                (
                    "Wire the login route to the auth model result and return the token "
                    "response for valid credentials."
                ),
                (
                    "Add route-level tests for successful token return and invalid "
                    "credential rejection."
                ),
            ],
            "user_story": (
                "As an API consumer, I want auth routes to return tokens, "
                "so that I can start a session."
            ),
            "acceptance": [
                (
                    "Given valid credentials, when the login route runs, "
                    "then it returns an access token."
                ),
                (
                    "Given invalid credentials, when the login route runs, "
                    "then it rejects the request."
                ),
            ],
            "traces": ["FR-2"],
            "swarm": {
                "readiness": "ready",
                "parallel_safe": True,
                "file_scope": ["src/auth/routes.ts", "tests/auth/routes.test.ts"],
                "verify_commands": ["npm test -- auth/routes"],
                "expected_outputs": ["auth route tests pass"],
                "depends_on": ["story-auth-model"],
                "conflict_group": "auth",
                "size": "small",
                "file_scope_confidence": "high",
                "model_tier": "medium",
            },
        },
    ]
    draft = {"stories": stories}
    if output_dir:
        draft["output_dir"] = output_dir
        draft["status"] = "running"
    return _write_json(project / "decomposition.json", draft)


def _run(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args, "--project-root", str(project)],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


def test_load_json_wraps_read_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    module = _load_scope_module()
    path = tmp_path / "decomposition.json"

    def fail_read_text(self: Path, *args: object, **kwargs: object) -> str:
        raise OSError("boom")

    monkeypatch.setattr(Path, "read_text", fail_read_text)

    with pytest.raises(module.DecompositionError, match="cannot read file"):
        module._load_json(path)


def test_scope_decompose_creates_child_stories_and_updates_parent_refs(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 0, result.stderr
    child_paths = sorted((tmp_path / "vbrief" / "pending").glob("2026-05-12-auth-*.vbrief.json"))
    assert len(child_paths) == 2
    child = json.loads(child_paths[0].read_text(encoding="utf-8"))
    assert child["plan"]["planRef"] == "pending/2026-05-12-ip001-auth.vbrief.json"
    assert child["plan"]["metadata"]["kind"] == "story"
    assert child["plan"]["metadata"]["swarm"]["readiness"] == "ready"
    assert child["plan"]["items"]
    assert child["plan"]["references"][0]["uri"] == "specification.vbrief.json"
    assert child["plan"]["references"][0]["TrustLevel"] == "internal"
    assert all(
        "acceptance" not in ref.get("type", "").lower()
        for ref in child["plan"]["references"]
    )

    updated_parent = json.loads(parent.read_text(encoding="utf-8"))
    child_uris = {
        f"pending/{path.name}"
        for path in child_paths
    }
    child_refs = [
        ref
        for ref in updated_parent["plan"]["references"]
        if ref.get("type") == "x-vbrief/plan" and ref.get("uri") in child_uris
    ]
    assert len(child_refs) == 2
    assert {ref["TrustLevel"] for ref in child_refs} == {"internal"}
    assert updated_parent["plan"]["narratives"]["Acceptance"].startswith("Auth epic")


def test_scope_decompose_rejects_existing_child_path(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)
    _write_json(
        tmp_path / "vbrief" / "pending" / "2026-05-12-auth-model.vbrief.json",
        {"existing": True},
    )

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 1
    assert "overwriting is not supported" in result.stderr


def test_scope_decompose_rejects_non_object_parent_metadata(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    parent_data = json.loads(parent.read_text(encoding="utf-8"))
    parent_data["plan"]["metadata"] = "phase"
    _write_json(parent, parent_data)
    draft = _draft(tmp_path)

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 1
    assert "plan.metadata must be an object" in result.stderr
    assert not list((tmp_path / "vbrief" / "pending").glob("2026-05-12-auth-*.vbrief.json"))


def test_scope_decompose_rejects_output_dir_outside_vbrief(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)
    draft_data = json.loads(draft.read_text(encoding="utf-8"))
    draft_data["output_dir"] = str(tmp_path / "outside" / "active")
    _write_json(draft, draft_data)

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 1
    assert "output_dir must be inside vbrief/" in result.stderr
    assert "Traceback" not in result.stderr


def test_scope_decompose_check_rejects_dependency_cycles(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path, cycle=True)

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert "dependency cycle" in result.stderr


def test_scope_decompose_cycle_report_excludes_upstream_story(tmp_path: Path) -> None:
    parent = _parent(tmp_path)

    def story(story_id: str, deps: list[str]) -> dict:
        return {
            "id": story_id,
            "title": story_id,
            "description": (
                f"{story_id} covers a narrow dependency-graph behavior for decomposition safety. "
                "The story text is intentionally concrete enough to exercise cycle validation."
            ),
            "implementation_plan": [
                f"Implement the {story_id} scoped behavior inside its isolated source file.",
                f"Add a focused test proving {story_id} returns success and rejects failure input.",
            ],
            "user_story": (
                f"As a developer, I want {story_id} behavior isolated, "
                "so that dependency order stays safe."
            ),
            "acceptance": [
                f"Given {story_id} input, when the story runs, then it returns a scoped result.",
                (
                    f"Given {story_id} failure input, when the story runs, "
                    "then it rejects the request."
                ),
            ],
            "traces": ["FR-1"],
            "swarm": {
                "readiness": "ready",
                "parallel_safe": True,
                "file_scope": [f"src/{story_id}.ts"],
                "verify_commands": [f"npm test -- {story_id}"],
                "expected_outputs": ["tests pass"],
                "depends_on": deps,
                "conflict_group": "auth",
                "size": "small",
                "file_scope_confidence": "high",
                "model_tier": "medium",
            },
        }

    draft = _write_json(
        tmp_path / "decomposition.json",
        {
            "stories": [
                story("story-entry", ["story-branch"]),
                story("story-branch", ["story-loop"]),
                story("story-loop", ["story-branch"]),
            ]
        },
    )

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert "dependency cycle detected: story-branch -> story-loop -> story-branch" in result.stderr
    assert "story-entry -> story-branch -> story-loop -> story-branch" not in result.stderr


def test_scope_decompose_rejects_ready_story_missing_required_fields(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _write_json(
        tmp_path / "bad-decomposition.json",
        {
            "stories": [
                {
                    "id": "story-bad",
                    "title": "Bad story",
                    "swarm": {"readiness": "ready", "parallel_safe": True},
                }
            ]
        },
    )

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert "plan.items" in result.stderr
    assert "file_scope" in result.stderr
    assert "verify_commands" in result.stderr


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (
            lambda story: story.update(
                {
                    "acceptance": [
                        "to refine from parent scope",
                        "Given a valid payload, when auth saves it, then it returns success.",
                    ]
                }
            ),
            "placeholder acceptance criterion",
        ),
        (
            lambda story: story.update(
                {
                    "acceptance": [
                        story["title"],
                        "Given a valid payload, when auth saves it, then it returns success.",
                    ]
                }
            ),
            "acceptance criterion duplicates title or description",
        ),
        (
            lambda story: story["swarm"].update({"file_scope": ["backend/**"]}),
            "broad file_scope is not swarm-ready",
        ),
        (
            lambda story: story["swarm"].update({"file_scope": ["src/*.ts"]}),
            "broad file_scope is not swarm-ready",
        ),
        (
            lambda story: story["swarm"].update({"verify_commands": ["task check"]}),
            "generic verify command is not swarm-ready",
        ),
        (
            lambda story: story["swarm"].update({"parallel_safe": False}),
            "readiness=ready requires parallel_safe=true",
        ),
        (
            lambda story: story["swarm"].update({"file_scope_confidence": "low"}),
            "readiness=ready requires file_scope_confidence above low",
        ),
        (
            lambda story: story.update({"user_story": "Build auth model."}),
            "UserStory must match",
        ),
        (
            lambda story: story.update({"description": "Persist auth records."}),
            "plan.narratives.Description must contain at least two concrete sentences",
        ),
        (
            lambda story: story.update({"implementation_plan": "Update model code."}),
            "plan.narratives.ImplementationPlan must contain at least two concrete steps",
        ),
        (
            lambda story: story.update(
                {
                    "implementation_plan": [
                        "Update the code so the feature is implemented in the application.",
                        "Add tests so it works as expected for users.",
                    ]
                }
            ),
            "plan.narratives.ImplementationPlan must identify concrete code paths",
        ),
        (
            lambda story: story.update(
                {
                    "acceptance": [
                        "The system displays a message",
                        (
                            "Given a valid payload, when auth saves it, "
                            "then it returns success."
                        ),
                    ]
                }
            ),
            "acceptance criterion must describe specific observable behavior",
        ),
    ],
)
def test_scope_decompose_rejects_low_quality_ready_story(
    tmp_path: Path, mutate, expected: str
) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)
    data = json.loads(draft.read_text(encoding="utf-8"))
    mutate(data["stories"][0])
    draft.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert expected in result.stderr


def test_scope_decompose_rejects_deprecated_subitems_in_story_items(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)
    data = json.loads(draft.read_text(encoding="utf-8"))
    first_story = data["stories"][0]
    first_story["items"] = [
        {
            "id": "story-auth-model-a1",
            "title": "Persist user payload",
            "status": "pending",
            "narrative": {
                "Acceptance": (
                    "Given a valid payload, when auth saves it, then it returns success."
                ),
                "Traces": "FR-1",
            },
            "subItems": [],
        }
    ]
    del first_story["acceptance"]
    draft.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 1
    assert "subItems is deprecated; use items" in result.stderr


def test_scope_decompose_allows_non_ready_sequential_story(tmp_path: Path) -> None:
    parent = _parent(tmp_path)
    draft = _draft(tmp_path)
    data = json.loads(draft.read_text(encoding="utf-8"))
    data["stories"][0]["swarm"].update(
        {
            "readiness": "sequential",
            "parallel_safe": False,
            "file_scope_confidence": "low",
        }
    )
    draft.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--check",
    )

    assert result.returncode == 0, result.stderr


def test_scope_decompose_to_active_stories_passes_readiness(tmp_path: Path) -> None:
    parent = _parent(tmp_path, folder="active")
    draft = _draft(tmp_path, output_dir="vbrief/active")

    result = _run(
        tmp_path,
        str(parent.relative_to(tmp_path)),
        "--draft",
        str(draft.relative_to(tmp_path)),
        "--date",
        "2026-05-12",
    )

    assert result.returncode == 0, result.stderr
    story_paths = [
        path
        for path in sorted((tmp_path / "vbrief" / "active").glob("*.vbrief.json"))
        if path.name != parent.name
    ]
    readiness = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "swarm_readiness.py"),
            *(str(path.relative_to(tmp_path)) for path in story_paths),
            "--project-root",
            str(tmp_path),
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    assert readiness.returncode == 0, readiness.stdout + readiness.stderr
    assert "Ready stories:" in readiness.stdout
    assert "story-auth-model" in readiness.stdout
    assert "story-auth-routes" in readiness.stdout
