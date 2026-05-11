"""tests/cli/test_managed_section_v3.py -- managed-section v3 sentinel (#1046 PR-B AC-5).

Covers the v2 -> v3 marker bump in ``run``:

- ``_parse_managed_section_attrs`` extracts ``sha`` / ``refreshed`` / ``session``
  attributes from a v3 marker; extras land in ``extras``; v2 markers parse with
  ``version=2`` and ``None`` attrs.
- ``_strip_managed_section_attrs`` normalises any attributed v3 marker (and a
  v2 marker) to the bare ``<!-- deft:managed-section v3 -->`` form so
  staleness comparison is per-refresh attribute insensitive.
- ``_attribute_render_managed_section`` injects the ``sha`` / ``refreshed`` /
  ``session`` triple into a bare-rendered block.
- ``_classify_agents_md`` reports v2 markers as ``stale`` so the next refresh
  upgrades them to v3 (one-release back-compat parse window).
- ``cmd_agents_refresh`` stamps the v3 attributes on every write
  (``absent`` / ``missing`` / ``stale``) and re-running on a current file
  is a no-op (the attribute strip normalises both sides before comparing).
- ``_maybe_warn_same_session_refresh`` emits a warn when ``DEFT_SESSION_ID``
  matches the embedded session token; stays silent when the env var is unset
  or the token differs.
- The injected ``refreshed`` timestamp parses as ISO 8601 UTC.

Story: #1046 PR-B AC-5.
"""

from __future__ import annotations

import re
from datetime import datetime

_BARE_V3 = "<!-- deft:managed-section v3 -->"
_CLOSE = "<!-- /deft:managed-section -->"
_BARE_V2 = "<!-- deft:managed-section v2 -->"


def _bare_template_body() -> str:
    """Minimal v3 template body the tests patch into ``_read_agents_template``."""
    return f"{_BARE_V3}\n# Deft\nBody\n{_CLOSE}\n"


def _patch_template(monkeypatch, deft_run_module, template_text: str | None = None):
    monkeypatch.setattr(
        deft_run_module,
        "_read_agents_template",
        lambda: template_text if template_text is not None else _bare_template_body(),
    )


# ---------------------------------------------------------------------------
# _parse_managed_section_attrs
# ---------------------------------------------------------------------------


class TestParseManagedSectionAttrs:
    def test_parses_v3_attributes(self, deft_run_module):
        section = (
            "<!-- deft:managed-section v3 "
            "sha=abc123 refreshed=2026-05-11T15:30:52Z session=feedface -->"
            f"\nbody\n{_CLOSE}"
        )
        attrs = deft_run_module._parse_managed_section_attrs(section)
        assert attrs is not None
        assert attrs["version"] == 3
        assert attrs["sha"] == "abc123"
        assert attrs["refreshed"] == "2026-05-11T15:30:52Z"
        assert attrs["session"] == "feedface"
        assert attrs["extras"] == {}

    def test_parses_quoted_attribute_values(self, deft_run_module):
        section = (
            "<!-- deft:managed-section v3 "
            "sha='abc123' refreshed='2026-05-11T00:00:00Z' session=\"feedface\" -->"
            f"\nbody\n{_CLOSE}"
        )
        attrs = deft_run_module._parse_managed_section_attrs(section)
        assert attrs is not None
        assert attrs["sha"] == "abc123"
        assert attrs["refreshed"] == "2026-05-11T00:00:00Z"
        assert attrs["session"] == "feedface"

    def test_parses_v2_marker_with_no_attrs(self, deft_run_module):
        section = f"{_BARE_V2}\nbody\n{_CLOSE}"
        attrs = deft_run_module._parse_managed_section_attrs(section)
        assert attrs is not None
        assert attrs["version"] == 2
        assert attrs["sha"] is None
        assert attrs["refreshed"] is None
        assert attrs["session"] is None

    def test_extras_capture_unknown_keys(self, deft_run_module):
        section = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z "
            "session=ff future=xyz -->"
            f"\nbody\n{_CLOSE}"
        )
        attrs = deft_run_module._parse_managed_section_attrs(section)
        assert attrs["extras"] == {"future": "xyz"}

    def test_returns_none_when_no_marker(self, deft_run_module):
        assert deft_run_module._parse_managed_section_attrs("# Just prose") is None


# ---------------------------------------------------------------------------
# _strip_managed_section_attrs
# ---------------------------------------------------------------------------


class TestStripManagedSectionAttrs:
    def test_strips_v3_attributes(self, deft_run_module):
        section = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z "
            f"session=ff -->\nbody\n{_CLOSE}"
        )
        normalised = deft_run_module._strip_managed_section_attrs(section)
        assert normalised.startswith(_BARE_V3)
        assert "sha=" not in normalised

    def test_normalises_v2_to_bare_v3(self, deft_run_module):
        section = f"{_BARE_V2}\nbody\n{_CLOSE}"
        normalised = deft_run_module._strip_managed_section_attrs(section)
        assert normalised.startswith(_BARE_V3)
        assert _BARE_V2 not in normalised

    def test_idempotent_on_bare_v3(self, deft_run_module):
        section = f"{_BARE_V3}\nbody\n{_CLOSE}"
        assert deft_run_module._strip_managed_section_attrs(section) == section


# ---------------------------------------------------------------------------
# _attribute_render_managed_section
# ---------------------------------------------------------------------------


class TestAttributeRender:
    def test_injects_triple_into_bare_render(self, deft_run_module):
        bare = f"{_BARE_V3}\nbody\n{_CLOSE}"
        attributed = deft_run_module._attribute_render_managed_section(
            bare,
            framework_sha="abc123def456",
            refreshed="2026-05-11T15:30:52Z",
            session_id="feedface1234",
        )
        assert attributed.startswith(
            "<!-- deft:managed-section v3 "
            "sha=abc123def456 refreshed=2026-05-11T15:30:52Z session=feedface1234 -->"
        )
        assert attributed.endswith(_CLOSE)
        # Body bytes between markers preserved verbatim.
        assert "\nbody\n" in attributed

    def test_round_trip_with_strip_returns_bare_form(self, deft_run_module):
        bare = f"{_BARE_V3}\nbody\n{_CLOSE}"
        attributed = deft_run_module._attribute_render_managed_section(
            bare,
            framework_sha="abc",
            refreshed="2026-05-11T00:00:00Z",
            session_id="ff",
        )
        normalised = deft_run_module._strip_managed_section_attrs(attributed)
        assert normalised == bare

    def test_iso_8601_timestamp_regression(self, deft_run_module):
        """``refreshed`` MUST round-trip through ``datetime.fromisoformat``."""
        ts = deft_run_module._now_utc_iso()
        # Format: YYYY-MM-DDTHH:MM:SSZ
        assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", ts)
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        assert parsed.tzinfo is not None


# ---------------------------------------------------------------------------
# _classify_agents_md -- v2 back-compat forces "stale"
# ---------------------------------------------------------------------------


class TestClassifyAgentsMdV2Backcompat:
    def test_v2_marker_classifies_as_stale(self, tmp_path, deft_run_module, monkeypatch):
        _patch_template(monkeypatch, deft_run_module)
        # Body bytes identical to v3 template body, marker is v2.
        legacy = f"{_BARE_V2}\n# Deft\nBody\n{_CLOSE}\n"
        (tmp_path / "AGENTS.md").write_text(legacy, encoding="utf-8")
        assert deft_run_module._classify_agents_md(tmp_path) == "stale"

    def test_bare_v3_current_body_classifies_as_current(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _patch_template(monkeypatch, deft_run_module)
        (tmp_path / "AGENTS.md").write_text(_bare_template_body(), encoding="utf-8")
        assert deft_run_module._classify_agents_md(tmp_path) == "current"

    def test_attributed_v3_current_body_classifies_as_current(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _patch_template(monkeypatch, deft_run_module)
        attributed_open = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z session=ff -->"
        )
        attributed_body = f"{attributed_open}\n# Deft\nBody\n{_CLOSE}\n"
        (tmp_path / "AGENTS.md").write_text(attributed_body, encoding="utf-8")
        # Attributes MUST NOT poison the staleness check.
        assert deft_run_module._classify_agents_md(tmp_path) == "current"


# ---------------------------------------------------------------------------
# cmd_agents_refresh -- v3 attribute stamping
# ---------------------------------------------------------------------------


class TestCmdAgentsRefreshStampsAttributes:
    def test_absent_write_stamps_v3_attrs(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        content = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        # v3 marker with attributes present.
        match = re.search(r"<!--\s*deft:managed-section v3\s+([^>]*?)\s*-->", content)
        assert match is not None
        attrs = match.group(1)
        assert "sha=" in attrs
        assert "refreshed=" in attrs
        assert "session=" in attrs

    def test_stale_v2_upgrade_writes_v3_attrs(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        # Pre-existing v2 file with same body bytes -> classifier flags as stale.
        legacy = f"{_BARE_V2}\n# Deft\nBody\n{_CLOSE}\n"
        (tmp_path / "AGENTS.md").write_text(legacy, encoding="utf-8")

        result = run_command("cmd_agents_refresh", [])

        assert result.return_code == 0
        new = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        # v2 form is replaced by an attributed v3 form.
        assert _BARE_V2 not in new
        assert "deft:managed-section v3" in new
        assert "sha=" in new
        assert "refreshed=" in new
        assert "session=" in new

    def test_double_run_is_idempotent_despite_per_refresh_attrs(
        self, tmp_path, run_command, deft_run_module, monkeypatch
    ):
        """Re-running refresh on a current file MUST be a no-op.

        The classifier normalises both sides via ``_strip_managed_section_attrs``
        so the per-refresh sha / refreshed / session triple does not poison
        idempotency.
        """
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        monkeypatch.chdir(tmp_path)
        _patch_template(monkeypatch, deft_run_module)
        run_command("cmd_agents_refresh", [])
        first = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        run_command("cmd_agents_refresh", [])
        second = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
        assert first == second


# ---------------------------------------------------------------------------
# _maybe_warn_same_session_refresh -- finding #6 escalation
# ---------------------------------------------------------------------------


class TestSameSessionRefreshWarn:
    def test_no_op_when_env_var_unset(self, tmp_path, deft_run_module, monkeypatch, capsys):
        monkeypatch.delenv("DEFT_SESSION_ID", raising=False)
        monkeypatch.setattr(deft_run_module, "_SAME_SESSION_REFRESH_WARNED", False)
        attributed = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z "
            f"session=ff -->\nbody\n{_CLOSE}\n"
        )
        (tmp_path / "AGENTS.md").write_text(attributed, encoding="utf-8")
        deft_run_module._maybe_warn_same_session_refresh(tmp_path)
        captured = capsys.readouterr()
        assert "session" not in captured.out.lower()

    def test_warns_when_env_var_matches_embedded_session(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        monkeypatch.setattr(deft_run_module, "_SAME_SESSION_REFRESH_WARNED", False)
        monkeypatch.setenv("DEFT_SESSION_ID", "matching-session-id")
        attributed = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z "
            f"session=matching-session-id -->\nbody\n{_CLOSE}\n"
        )
        (tmp_path / "AGENTS.md").write_text(attributed, encoding="utf-8")
        deft_run_module._maybe_warn_same_session_refresh(tmp_path)
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "matching-session-id" in combined
        assert "Start a NEW agent session" in combined or "new agent session" in combined.lower()

    def test_no_op_when_env_var_differs(self, tmp_path, deft_run_module, monkeypatch, capsys):
        monkeypatch.setattr(deft_run_module, "_SAME_SESSION_REFRESH_WARNED", False)
        monkeypatch.setenv("DEFT_SESSION_ID", "a-different-session")
        attributed = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z "
            f"session=feedface -->\nbody\n{_CLOSE}\n"
        )
        (tmp_path / "AGENTS.md").write_text(attributed, encoding="utf-8")
        deft_run_module._maybe_warn_same_session_refresh(tmp_path)
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "feedface" not in combined

    def test_no_op_when_v2_marker_carries_no_session_token(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        monkeypatch.setattr(deft_run_module, "_SAME_SESSION_REFRESH_WARNED", False)
        monkeypatch.setenv("DEFT_SESSION_ID", "anything")
        (tmp_path / "AGENTS.md").write_text(f"{_BARE_V2}\nbody\n{_CLOSE}\n", encoding="utf-8")
        deft_run_module._maybe_warn_same_session_refresh(tmp_path)
        captured = capsys.readouterr()
        assert "Start a NEW" not in (captured.out + captured.err)

    def test_fires_only_once_per_session(self, tmp_path, deft_run_module, monkeypatch, capsys):
        monkeypatch.setattr(deft_run_module, "_SAME_SESSION_REFRESH_WARNED", False)
        monkeypatch.setenv("DEFT_SESSION_ID", "loop")
        attributed = (
            "<!-- deft:managed-section v3 sha=abc refreshed=2026-05-11T00:00:00Z "
            f"session=loop -->\nbody\n{_CLOSE}\n"
        )
        (tmp_path / "AGENTS.md").write_text(attributed, encoding="utf-8")
        deft_run_module._maybe_warn_same_session_refresh(tmp_path)
        deft_run_module._maybe_warn_same_session_refresh(tmp_path)
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        # Warn line carries the issue ref; assert exactly one occurrence.
        assert combined.count("Refs #1046 finding #6") == 1
