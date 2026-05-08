"""tests/integration/test_scm_smoke.py -- integration smoke for #883 Story 1 + #976.

Live test exercising the scm.py wrapper against the real ``gh`` CLI / REST
endpoints and the real ``deftai/directive`` repository. Skipped when:

- ``DEFT_NO_NETWORK=1`` is set (CI lanes that disallow network).
- ``gh`` (or ``ghx``) is not on PATH (we have no binary to dispatch to).
- ``gh auth status`` fails (e.g. GitHub Actions runner without ``GH_TOKEN``
  exported into the test job env). The smoke is meant to prove wrapper
  round-trips against a real gh; it is not a credential gate, so we skip
  cleanly when no usable token is present rather than fail the lane.
- Bucket awareness (#976): a live ``gh api rate_limit`` probe (REST, the
  uncached form per AGENTS.md ``## Multi-agent orchestration discipline
  (#954)``) checks that the bucket the smoke depends on has remaining
  quota. The REST path requires only ``core.remaining``; if depleted, we
  skip cleanly. Pre-#976 the smoke shelled out to ``gh issue view --json``
  which routes through GraphQL, so unrelated GraphQL exhaustion (e.g.
  swarm cohorts elsewhere on the same identity) would fail this smoke
  and block ``task check`` on PRs that did not touch the SCM stub. The
  smoke now opts into ``--rest`` so GraphQL exhaustion is no longer a
  failure mode.

Asserts a non-empty JSON body comes back with at minimum {number, title}
populated -- enough to prove the wrapper round-trips a real REST response
without re-implementing the full contract suite (that lives in the unit
tests at tests/test_scm_stub.py).

Refs #976 (REST migration), #883 (Story 1 stub), #884 (ghx ladder), #954
(REST-by-default rule), #961 (REST helpers).
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

scm = importlib.import_module("scm")

# The smoke target: deftai/directive issue #1 is the seed issue; presence
# is stable enough for a real-network smoke. We pull `--json number,title`
# only to keep the surface tiny -- the contract assertions live in the
# unit tests (test_scm_stub.py) where they don't depend on network.
SMOKE_REPO = "deftai/directive"
SMOKE_ISSUE = "1"

#: Minimum REST `core` budget required for one ``rest_issue_view`` call
#: plus the rate-limit probe itself plus margin for any retries. Below
#: this the smoke skips cleanly with a clear reason.
_MIN_CORE_BUDGET = 10

#: Skip-marker reused on every test that touches the live network.
#: Greptile P1 #998 review at 367748e: a module-level ``pytestmark``
#: would cascade to every class in this file, including the hermetic
#: ``TestProbeRateLimitMalformedPayloads`` class which monkeypatches
#: ``subprocess.run`` and never touches the network. Applying the
#: skip per-test instead lets the regression coverage run in CI lanes
#: that set ``DEFT_NO_NETWORK=1``.
_NETWORK_SKIP = pytest.mark.skipif(
    os.environ.get("DEFT_NO_NETWORK") == "1",
    reason="DEFT_NO_NETWORK=1 disables network-dependent integration tests",
)


def _binary_available() -> bool:
    return shutil.which("ghx") is not None or shutil.which("gh") is not None


def _gh_authenticated() -> bool:
    """Return True when ``gh auth status`` reports a usable token.

    Used as a skip-guard so CI lanes that do not export ``GH_TOKEN`` into
    the pytest job (e.g. our default ``Python (lint + type-check + test)``
    workflow) skip the live smoke instead of failing it. Locally, devs who
    have run ``gh auth login`` will have status==0 and the smoke will run.
    """
    if shutil.which("gh") is None:
        # If only ghx is on PATH we cannot probe auth here; let the test
        # attempt and surface any auth issue. ghx wrappers typically
        # supply their own credentials.
        return shutil.which("ghx") is not None
    try:
        proc = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return False
    return proc.returncode == 0


def _probe_rate_limit() -> dict[str, int] | None:
    """Return ``{"core": N, "graphql": M}`` from a live ``gh api rate_limit`` call.

    Returns ``None`` if the probe itself fails (network down, gh
    unauthenticated, etc.) so the caller can downgrade to a soft skip
    instead of treating a probe failure as a smoke failure.

    Per AGENTS.md ``## Multi-agent orchestration discipline (#954)`` the
    probe MUST be the live REST form (``gh api rate_limit``) NOT
    ``ghx api rate_limit``: ghx is a cached read-only proxy whose
    cached value can be stale under N concurrent workers between probe
    and use, defeating the throttle.

    Defensive against malformed payloads (Greptile P1 #998 review at
    feab4a8): every parsing step that could raise ``AttributeError`` /
    ``TypeError`` / ``ValueError`` (e.g. ``resources`` is JSON ``null``
    instead of an object, ``core`` is null, or ``remaining`` is non-
    numeric) is wrapped so the contract "return None on any probe
    failure" actually holds. Without this, the smoke would surface a
    hard test error on indeterminate API state instead of the intended
    soft skip.
    """
    if shutil.which("gh") is None:
        return None
    try:
        proc = subprocess.run(
            ["gh", "api", "rate_limit"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        body = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    # Wrap the entire resource-extraction block: a malformed payload
    # (resources=null, core=null, graphql=null, non-numeric remaining,
    # ...) MUST yield None per the docstring contract rather than
    # propagate AttributeError / TypeError / ValueError up the stack.
    try:
        if not isinstance(body, dict):
            return None
        resources = body.get("resources")
        if not isinstance(resources, dict):
            return None
        core = resources.get("core")
        graphql = resources.get("graphql")
        if not isinstance(core, dict) or not isinstance(graphql, dict):
            return None
        return {
            "core": int(core.get("remaining", 0)),
            "graphql": int(graphql.get("remaining", 0)),
        }
    except (AttributeError, TypeError, ValueError):
        return None


@_NETWORK_SKIP
@pytest.mark.skipif(
    not _binary_available(),
    reason="neither ghx nor gh on PATH; skipping live smoke",
)
@pytest.mark.skipif(
    not _gh_authenticated(),
    reason="gh CLI is not authenticated (no GH_TOKEN); skipping live smoke",
)
def test_scm_issue_view_rest_returns_nonempty_json() -> None:
    """``scm.py issue view --rest 1 --repo deftai/directive --json number,title`` -> populated dict.

    Bucket-aware (#976): exercises the REST opt-in path so GraphQL
    depletion (a recurring failure mode under shared-identity swarm
    workflows) no longer fails this smoke. Skips cleanly if the REST
    ``core`` bucket is itself depleted -- treating bucket exhaustion
    as a runtime condition rather than a test failure prevents this
    smoke from blocking unrelated PRs.
    """
    rate = _probe_rate_limit()
    if rate is None:
        pytest.skip(
            "gh api rate_limit probe failed -- live smoke requires a probe "
            "baseline; skipping rather than failing on indeterminate state"
        )
    if rate["core"] < _MIN_CORE_BUDGET:
        pytest.skip(
            f"REST core bucket depleted (remaining={rate['core']} < "
            f"{_MIN_CORE_BUDGET}); skipping live smoke until reset. "
            "GraphQL bucket state is irrelevant here -- the --rest path "
            "does not touch GraphQL."
        )
    # Invoke scm.py via subprocess so the test actually exercises the
    # PATH-resolved binary AND the --rest dispatcher end-to-end. The
    # alternative (calling scm.main directly) would inherit pytest's
    # captured stdout and miss the real subprocess plumbing this smoke
    # is meant to verify.
    cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "scm.py"),
        "issue",
        "view",
        "--rest",
        SMOKE_ISSUE,
        "--repo",
        SMOKE_REPO,
        "--json",
        "number,title",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, (
        f"scm.py --rest exit={proc.returncode} stderr={proc.stderr!r}"
    )
    payload = proc.stdout.strip()
    assert payload, "scm.py --rest issue view emitted empty stdout against real REST"
    parsed = json.loads(payload)
    assert isinstance(parsed, dict), (
        f"expected JSON object from --rest issue view, got {type(parsed).__name__}"
    )
    assert "number" in parsed and isinstance(parsed["number"], int)
    assert parsed["number"] == int(SMOKE_ISSUE)
    assert "title" in parsed and isinstance(parsed["title"], str) and parsed["title"]


# ---------------------------------------------------------------------------
# Hermetic unit tests for _probe_rate_limit malformed-payload paths
# (Greptile P1 #998 review at feab4a8). These tests do NOT touch the
# network -- they monkeypatch shutil.which / subprocess.run so the
# pytestmark skip-on-DEFT_NO_NETWORK at module level still allows them
# to run in any local dev environment.
# ---------------------------------------------------------------------------


class TestProbeRateLimitMalformedPayloads:
    """``_probe_rate_limit`` returns ``None`` on every malformed-payload edge case.

    Pre-fix the function would raise ``AttributeError`` on
    ``resources=null`` / ``core=null`` etc. because ``dict.get(key,
    default)`` returns ``None`` (not the default) when the key exists
    with a literal-null value, then ``None.get(...)`` blows up. The
    docstring contract is "return None on any probe failure"; these
    tests pin every codepath to that contract.
    """

    @staticmethod
    def _fake_proc(stdout: str, returncode: int = 0) -> types.SimpleNamespace:
        return types.SimpleNamespace(
            returncode=returncode, stdout=stdout, stderr=""
        )

    @pytest.mark.parametrize(
        "payload",
        [
            # Top-level body is not a dict.
            "null",
            "[1, 2, 3]",
            '"a string"',
            # Top-level dict but resources is JSON null.
            '{"resources": null}',
            # resources is not a dict.
            '{"resources": [1, 2]}',
            '{"resources": "string"}',
            # core is null.
            '{"resources": {"core": null, "graphql": {"remaining": 5000}}}',
            # graphql is null.
            '{"resources": {"core": {"remaining": 5000}, "graphql": null}}',
            # core is not a dict.
            '{"resources": {"core": [1, 2], "graphql": {"remaining": 5000}}}',
            # remaining is non-numeric (int() raises ValueError).
            '{"resources": {"core": {"remaining": "NaN"},'
            ' "graphql": {"remaining": 5000}}}',
            # remaining is missing on one bucket -- default 0 is fine,
            # this case should NOT trip the guard. Asserted separately.
        ],
    )
    def test_malformed_payload_returns_none(
        self, monkeypatch: pytest.MonkeyPatch, payload: str
    ) -> None:
        # Pin shutil.which so the gh-not-on-PATH early return is bypassed.
        monkeypatch.setattr(shutil, "which", lambda _binary: "/usr/bin/gh")
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *_a, **_kw: self._fake_proc(payload),
        )
        assert _probe_rate_limit() is None

    def test_well_formed_payload_returns_dict(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Belt-and-suspenders: confirm the happy path still returns the
        # parsed remaining values and is unaffected by the new guards.
        payload = (
            '{"resources": {"core": {"remaining": 4998},'
            ' "graphql": {"remaining": 4500}}}'
        )
        monkeypatch.setattr(shutil, "which", lambda _binary: "/usr/bin/gh")
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *_a, **_kw: self._fake_proc(payload),
        )
        assert _probe_rate_limit() == {"core": 4998, "graphql": 4500}

    def test_missing_remaining_key_uses_default_zero(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # ``remaining`` missing on either bucket falls back to 0 (the
        # caller treats 0 < _MIN_CORE_BUDGET as "depleted" and skips
        # cleanly). This is the documented graceful-degradation path,
        # NOT a hard error.
        payload = '{"resources": {"core": {}, "graphql": {}}}'
        monkeypatch.setattr(shutil, "which", lambda _binary: "/usr/bin/gh")
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *_a, **_kw: self._fake_proc(payload),
        )
        assert _probe_rate_limit() == {"core": 0, "graphql": 0}

    def test_subprocess_oserror_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Already covered pre-fix; pinning here so refactors that move
        # the OSError catch don't regress the contract.
        def boom(*_a: object, **_kw: object) -> object:
            raise OSError("network down")

        monkeypatch.setattr(shutil, "which", lambda _binary: "/usr/bin/gh")
        monkeypatch.setattr(subprocess, "run", boom)
        assert _probe_rate_limit() is None

    def test_non_zero_returncode_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(shutil, "which", lambda _binary: "/usr/bin/gh")
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *_a, **_kw: self._fake_proc("unauthenticated", returncode=4),
        )
        assert _probe_rate_limit() is None

    def test_invalid_json_returns_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(shutil, "which", lambda _binary: "/usr/bin/gh")
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *_a, **_kw: self._fake_proc("not-json{{"),
        )
        assert _probe_rate_limit() is None
