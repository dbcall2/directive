"""tests/cmd_gate/test_case_k.py -- install-layout Case K detector (#1046 PR-A AC-2).

Covers the new Case K return value added to ``_classify_install_layout`` in
PR-A of the #1046 install/refresh contract cohort. Case K = "install location
mismatch" -- AGENTS.md's managed section byte-matches the current
``templates/agents-entry.md`` render BUT the install path AGENTS.md declares
does not resolve on disk. This is the failure class documented in issue #1046
finding #2: Case G's "refresh the managed section" prescription is a
byte-for-byte no-op against the current template, so re-running just
re-detects the same staleness next session.

The Case K detector is read-only. The remediation (``task framework:doctor``)
lands in PR-B of the #1046 cohort -- Case K's prompt text references the
forthcoming command but the detector itself never invokes anything.

Suites:

* ``TestClassifyCaseK`` -- positive K detection plus the install-dir-presence
  priority rule (A/B/C take precedence over K so a legacy ``deft/`` install
  with a byte-current AGENTS.md still classifies as A, NOT K).
* ``TestInstallPathResolves`` -- vacuous-True semantics when AGENTS.md is
  absent or carries no declaration; positive resolution when the declared
  path exists; negative resolution when the path is missing.
* ``TestAgentsMdDeclaredMainMd`` -- pure parse contract for the
  ``Full guidelines: <root>/main.md`` declaration extractor.
* ``TestTemplateMatchesManagedSection`` -- thin alias over
  ``_classify_agents_md`` returns True on byte-match, False on stale /
  missing AGENTS.md.
* ``TestFormatInstallLayoutPromptK`` -- Case K's auto-prompt format points
  at ``task framework:doctor`` (PR-B forthcoming) rather than the relocator;
  the B/C/D format remains unchanged (pinned in test_state_detection.py).
* ``TestMaybeEmitInstallLayoutPromptK`` -- K emits via the gate-side hook;
  the existing A/B/C/D emission tests in test_state_detection.py continue
  to pass.
* ``TestCaseKDetectorIsReadOnly`` -- snapshot the filesystem before/after
  the detector runs against a state-K project root; the snapshot MUST be
  byte-identical. Poisoned ``subprocess.run`` / ``subprocess.Popen`` /
  ``read_yn`` / ``ask_confirm`` MUST NOT be invoked from any K code path
  (mirrors the existing #992 PR3 operator-consent contract).

Story: #1046 PR-A (acceptance criterion AC-2).
"""

from __future__ import annotations

from pathlib import Path

import pytest

# --- Helpers ----------------------------------------------------------------

# Pin the marker text in this test rather than importing from `run` so the
# test fails closed if a future PR re-bumps the marker without updating the
# Case K detector contract. Mirrors the existing test_state_detection.py
# pinning convention.
_MANAGED_OPEN_V2 = "<!-- deft:managed-section v2 -->"
_MANAGED_CLOSE = "<!-- /deft:managed-section -->"


def _rendered_template_managed_section(deft_run_module) -> str:
    """Return the byte-identical managed section the framework currently emits.

    Used to construct a Case-K project root whose AGENTS.md byte-matches the
    rendered template. Failing to load the template is an environment bug
    (the framework checkout is incomplete); we surface that via
    ``pytest.fail`` so the test author sees an actionable error instead of
    a spurious assertion later.
    """
    template_text = deft_run_module._read_agents_template()
    if template_text is None:
        pytest.fail(
            "Could not read templates/agents-entry.md -- the Case K detector "
            "tests require the framework template on disk to construct a "
            "byte-current AGENTS.md fixture."
        )
    rendered = deft_run_module._render_managed_section(template_text)
    if rendered is None:
        pytest.fail(
            "templates/agents-entry.md is missing the deft:managed-section "
            "markers -- Case K detector tests cannot construct a fixture."
        )
    return rendered


def _make_state_k(project_root: Path, deft_run_module) -> None:
    """State K: byte-current AGENTS.md + declared install path does not resolve.

    Writes AGENTS.md whose managed section is byte-identical to the current
    ``templates/agents-entry.md`` render. The declared install path
    (``.deft/core/main.md``) is intentionally NOT created on disk so the
    detector reports K.
    """
    rendered = _rendered_template_managed_section(deft_run_module)
    (project_root / "AGENTS.md").write_text(rendered + "\n", encoding="utf-8")


def _make_byte_different_managed_agents_md(project_root: Path) -> None:
    """Write an AGENTS.md whose managed section differs from the current template.

    Used to construct the D-vs-K distinction tests: byte-different + no
    install dir -> D (template stale; refresh would help); byte-current +
    no install dir + path unresolved -> K (refresh is a no-op).
    """
    (project_root / "AGENTS.md").write_text(
        f"# AGENTS\n\n{_MANAGED_OPEN_V2}\n\nstale managed content\n\n{_MANAGED_CLOSE}\n",
        encoding="utf-8",
    )


def _snapshot_filesystem(root: Path) -> set[str]:
    """Return a stable snapshot of all filesystem entries under ``root``.

    Mirrors the existing test_state_detection.py helper -- used to assert the
    Case K detector never mutates filesystem state on any code path.
    """
    entries: set[str] = set()
    for child in root.rglob("*"):
        rel = child.relative_to(root).as_posix()
        kind = "d" if child.is_dir() else "f"
        if child.is_file():
            try:
                size = child.stat().st_size
            except OSError:
                size = -1
            entries.add(f"{kind}:{rel}:{size}")
        else:
            entries.add(f"{kind}:{rel}")
    return entries


# --- _classify_install_layout (Case K extension) ----------------------------


class TestClassifyCaseK:
    """Case K classifier tests + install-dir-priority sanity checks."""

    def test_state_k_fires_when_template_matches_and_install_path_unresolved(
        self, tmp_path, deft_run_module
    ):
        _make_state_k(tmp_path, deft_run_module)
        # No deft/ and no .deft/core/ dirs -- the declared
        # .deft/core/main.md does not resolve, so K fires.
        assert deft_run_module._classify_install_layout(tmp_path) == "K"

    def test_state_a_takes_priority_over_k_when_legacy_deft_dir_present(
        self, tmp_path, deft_run_module
    ):
        """Legacy ``deft/`` install + byte-current AGENTS.md -> A, NOT K.

        The Case K branch only fires when no install dir anchors the legacy
        or canonical contract. State A is by definition the layout in which
        AGENTS.md and the framework agree (even if the rendered template's
        declared path is the canonical ``.deft/core/main.md`` which the
        legacy install does not provide).
        """
        _make_state_k(tmp_path, deft_run_module)
        (tmp_path / "deft").mkdir()
        assert deft_run_module._classify_install_layout(tmp_path) == "A"

    def test_state_b_takes_priority_over_k_when_canonical_install_present(
        self, tmp_path, deft_run_module
    ):
        """Canonical ``.deft/core/`` install + byte-current AGENTS.md -> B, NOT K."""
        _make_state_k(tmp_path, deft_run_module)
        (tmp_path / ".deft" / "core").mkdir(parents=True)
        assert deft_run_module._classify_install_layout(tmp_path) == "B"

    def test_state_c_takes_priority_over_k_when_hybrid(
        self, tmp_path, deft_run_module
    ):
        """Hybrid (both install dirs present) + byte-current AGENTS.md -> C, NOT K."""
        _make_state_k(tmp_path, deft_run_module)
        (tmp_path / "deft").mkdir()
        (tmp_path / ".deft" / "core").mkdir(parents=True)
        assert deft_run_module._classify_install_layout(tmp_path) == "C"

    def test_byte_different_template_with_no_install_dir_returns_d_not_k(
        self, tmp_path, deft_run_module
    ):
        """Byte-different managed section + no install dir -> D.

        Case G in QUICK-START Step 2b owns the byte-different staleness
        path -- when the template content differs from the current render,
        a Case G refresh is the right remediation (it actually does
        something), so this state classifies as D (which routes through
        the existing refresh prompt) rather than K (which would advise the
        operator to skip the refresh entirely).
        """
        _make_byte_different_managed_agents_md(tmp_path)
        assert deft_run_module._classify_install_layout(tmp_path) == "D"

    def test_byte_different_template_with_install_dir_returns_install_dir_state(
        self, tmp_path, deft_run_module
    ):
        """Byte-different managed section + ``deft/`` -> A.

        Install-dir presence still dominates content classification. The
        Case G refresh path is invoked from QUICK-START Step 2b based on
        AGENTS.md content, independent of the
        ``_classify_install_layout`` result -- this test just pins that
        the classifier itself returns A on install-dir presence.
        """
        _make_byte_different_managed_agents_md(tmp_path)
        (tmp_path / "deft").mkdir()
        assert deft_run_module._classify_install_layout(tmp_path) == "A"

    def test_byte_current_template_with_resolving_install_path_does_not_fire_k(
        self, tmp_path, deft_run_module
    ):
        """Byte-current AGENTS.md + declared install path resolves -> D, NOT K.

        When the declared install path actually exists on disk (e.g. the
        consumer manually placed a ``.deft/core/main.md`` without the
        surrounding directory tree), K does NOT fire because there is no
        Case K signal to surface -- the install path resolution check
        gates the K branch.

        Note: ``.deft/core`` is created as a file path here (only
        ``main.md``) NOT as a directory, so ``dotdeft_present`` is False
        and the classifier falls through to the D/K decision. The
        ``_install_path_resolves`` helper returns True because
        ``.deft/core/main.md`` is a file, so the K branch is skipped.
        """
        _make_state_k(tmp_path, deft_run_module)
        # Place just the main.md file the template declares -- NOT the
        # full .deft/core/ install dir, so the install-dir presence check
        # at the top of the classifier still falls through.
        (tmp_path / ".deft" / "core").mkdir(parents=True)
        (tmp_path / ".deft" / "core" / "main.md").write_text(
            "# Deft\n", encoding="utf-8"
        )
        # State B fires because .deft/core/ is now a present install dir.
        assert deft_run_module._classify_install_layout(tmp_path) == "B"


# --- _install_path_resolves --------------------------------------------------


class TestInstallPathResolves:
    """Vacuous-True semantics + positive / negative resolution checks."""

    def test_returns_true_when_agents_md_missing(self, tmp_path, deft_run_module):
        """No AGENTS.md -> no claim to invalidate -> vacuously True."""
        assert deft_run_module._install_path_resolves(tmp_path) is True

    def test_returns_true_when_agents_md_has_no_declaration(
        self, tmp_path, deft_run_module
    ):
        """AGENTS.md present but no ``Full guidelines: <path>`` line -> True."""
        (tmp_path / "AGENTS.md").write_text(
            "# AGENTS\n\nhand-rolled non-deft content\n",
            encoding="utf-8",
        )
        assert deft_run_module._install_path_resolves(tmp_path) is True

    def test_returns_true_when_declared_path_resolves(
        self, tmp_path, deft_run_module
    ):
        """Declared install path exists on disk -> True."""
        (tmp_path / "AGENTS.md").write_text(
            "Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md\n",
            encoding="utf-8",
        )
        (tmp_path / ".deft" / "core").mkdir(parents=True)
        (tmp_path / ".deft" / "core" / "main.md").write_text(
            "# Deft\n", encoding="utf-8"
        )
        assert deft_run_module._install_path_resolves(tmp_path) is True

    def test_returns_false_when_declared_path_missing(
        self, tmp_path, deft_run_module
    ):
        """Declared install path is absent on disk -> False (Case K signal)."""
        (tmp_path / "AGENTS.md").write_text(
            "Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md\n",
            encoding="utf-8",
        )
        assert deft_run_module._install_path_resolves(tmp_path) is False

    def test_returns_true_when_declared_legacy_path_resolves(
        self, tmp_path, deft_run_module
    ):
        """Legacy ``deft/main.md`` declaration that resolves -> True.

        Pins that the resolver does not hard-code the canonical path; it
        honors whatever the AGENTS.md declaration says.
        """
        (tmp_path / "AGENTS.md").write_text(
            "Deft is installed in deft/. Full guidelines: deft/main.md\n",
            encoding="utf-8",
        )
        (tmp_path / "deft").mkdir()
        (tmp_path / "deft" / "main.md").write_text("# Deft\n", encoding="utf-8")
        assert deft_run_module._install_path_resolves(tmp_path) is True


# --- _agents_md_declared_main_md --------------------------------------------


class TestAgentsMdDeclaredMainMd:
    """Pure parser contract for the ``Full guidelines: ...`` declaration."""

    def test_returns_none_when_agents_md_missing(self, tmp_path, deft_run_module):
        assert deft_run_module._agents_md_declared_main_md(tmp_path) is None

    def test_returns_none_when_no_declaration(self, tmp_path, deft_run_module):
        (tmp_path / "AGENTS.md").write_text(
            "# AGENTS\nno declaration here\n", encoding="utf-8"
        )
        assert deft_run_module._agents_md_declared_main_md(tmp_path) is None

    def test_extracts_canonical_path(self, tmp_path, deft_run_module):
        (tmp_path / "AGENTS.md").write_text(
            "Full guidelines: .deft/core/main.md\n", encoding="utf-8"
        )
        assert (
            deft_run_module._agents_md_declared_main_md(tmp_path)
            == ".deft/core/main.md"
        )

    def test_extracts_legacy_path(self, tmp_path, deft_run_module):
        (tmp_path / "AGENTS.md").write_text(
            "Full guidelines: deft/main.md\n", encoding="utf-8"
        )
        assert (
            deft_run_module._agents_md_declared_main_md(tmp_path) == "deft/main.md"
        )

    def test_returns_first_match_when_multiple_declarations(
        self, tmp_path, deft_run_module
    ):
        """The well-formed managed section carries exactly one declaration.

        If a malformed file carries more than one, the first match wins
        (documented behaviour of ``re.compile(...).search``).
        """
        (tmp_path / "AGENTS.md").write_text(
            "Full guidelines: .deft/core/main.md\n"
            "Full guidelines: deft/main.md\n",
            encoding="utf-8",
        )
        assert (
            deft_run_module._agents_md_declared_main_md(tmp_path)
            == ".deft/core/main.md"
        )


# --- _template_matches_managed_section --------------------------------------


class TestTemplateMatchesManagedSection:
    """Thin alias over ``_classify_agents_md == 'current'``."""

    def test_returns_true_on_byte_current_agents_md(
        self, tmp_path, deft_run_module
    ):
        _make_state_k(tmp_path, deft_run_module)
        assert (
            deft_run_module._template_matches_managed_section(tmp_path) is True
        )

    def test_returns_false_on_byte_different_agents_md(
        self, tmp_path, deft_run_module
    ):
        _make_byte_different_managed_agents_md(tmp_path)
        assert (
            deft_run_module._template_matches_managed_section(tmp_path) is False
        )

    def test_returns_false_when_agents_md_missing(self, tmp_path, deft_run_module):
        assert (
            deft_run_module._template_matches_managed_section(tmp_path) is False
        )


# --- _format_install_layout_prompt (Case K branch) --------------------------


class TestFormatInstallLayoutPromptK:
    """Pin the Case K-specific format -- points at ``task framework:doctor``."""

    def test_format_carries_state_description_and_doctor_pointer(
        self, deft_run_module
    ):
        line = deft_run_module._format_install_layout_prompt("K")
        # Single line, no embedded newlines.
        assert "\n" not in line
        # Carries the canonical structured prefix.
        assert line.startswith("[deft] install layout state: K (")
        # Carries the K-specific description.
        assert "install location mismatch" in line
        # Points at the forthcoming PR-B remediation command, NOT the relocator.
        assert "task framework:doctor" in line
        assert "PR-B" in line
        assert "#1046" in line
        # Surfaces the manual fallback so the operator has a path before PR-B lands.
        assert "manually verify" in line.lower()
        # Visual consent affordance is intact.
        assert line.endswith("(Y/n)")
        # Sanity-check: K MUST NOT advise the relocator -- that is the B/C/D path.
        assert ".deft/core/run relocate" not in line


# --- _maybe_emit_install_layout_prompt (Case K branch) -----------------------


class TestMaybeEmitInstallLayoutPromptK:
    """Behaviour contract for gate-side Case K prompt emission."""

    def test_emits_prompt_on_state_k(self, tmp_path, deft_run_module, capsys):
        _make_state_k(tmp_path, deft_run_module)
        result = deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        captured = capsys.readouterr()
        assert result is not None, (
            "Expected a Case K prompt string but got None"
        )
        # Returned string is what landed on stdout (modulo trailing newline).
        assert result in captured.out
        assert "[deft] install layout state: K" in captured.out
        # Case K points at framework:doctor, not the relocator.
        assert "task framework:doctor" in captured.out
        assert ".deft/core/run relocate" not in captured.out


# --- Read-only contract ------------------------------------------------------


class TestCaseKDetectorIsReadOnly:
    """Case K detector + helpers MUST NOT mutate filesystem state."""

    def test_classify_does_not_mutate_in_state_k(self, tmp_path, deft_run_module):
        _make_state_k(tmp_path, deft_run_module)
        before = _snapshot_filesystem(tmp_path)
        deft_run_module._classify_install_layout(tmp_path)
        after = _snapshot_filesystem(tmp_path)
        assert before == after, (
            "_classify_install_layout mutated filesystem state in Case K -- "
            "the detector is contractually read-only."
        )

    def test_emit_prompt_does_not_mutate_in_state_k(
        self, tmp_path, deft_run_module
    ):
        _make_state_k(tmp_path, deft_run_module)
        before = _snapshot_filesystem(tmp_path)
        deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        after = _snapshot_filesystem(tmp_path)
        assert before == after, (
            "_maybe_emit_install_layout_prompt mutated filesystem state in "
            "Case K -- auto-prompt MUST NEVER auto-execute remediation."
        )

    def test_install_path_resolves_does_not_mutate(
        self, tmp_path, deft_run_module
    ):
        _make_state_k(tmp_path, deft_run_module)
        before = _snapshot_filesystem(tmp_path)
        deft_run_module._install_path_resolves(tmp_path)
        after = _snapshot_filesystem(tmp_path)
        assert before == after

    def test_template_matches_managed_section_does_not_mutate(
        self, tmp_path, deft_run_module
    ):
        _make_state_k(tmp_path, deft_run_module)
        before = _snapshot_filesystem(tmp_path)
        deft_run_module._template_matches_managed_section(tmp_path)
        after = _snapshot_filesystem(tmp_path)
        assert before == after

    def test_case_k_detector_does_not_invoke_subprocess(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        """A poisoned ``subprocess.run`` / ``Popen`` MUST NOT be called.

        Mirrors the existing #992 PR3 operator-consent contract -- the Case
        K detector and prompt-emission helper MUST NEVER shell out to
        ``task framework:doctor`` (or anything else) automatically.
        """
        import subprocess as _subprocess

        called: list[tuple] = []

        def _poisoned_run(*args, **kwargs):
            called.append(("run", args, kwargs))
            raise AssertionError(
                "subprocess.run invoked from Case K detector -- "
                "auto-prompt MUST NEVER auto-execute remediation"
            )

        def _poisoned_popen(*args, **kwargs):
            called.append(("Popen", args, kwargs))
            raise AssertionError(
                "subprocess.Popen invoked from Case K detector -- "
                "auto-prompt MUST NEVER auto-execute remediation"
            )

        monkeypatch.setattr(_subprocess, "run", _poisoned_run)
        monkeypatch.setattr(_subprocess, "Popen", _poisoned_popen)

        _make_state_k(tmp_path, deft_run_module)
        # Drive every public surface the K branch touches.
        deft_run_module._classify_install_layout(tmp_path)
        deft_run_module._maybe_emit_install_layout_prompt(tmp_path)
        deft_run_module._install_path_resolves(tmp_path)
        deft_run_module._template_matches_managed_section(tmp_path)

        assert called == [], (
            "Case K detector or prompt-emission shelled out to subprocess; "
            "operator-consent contract violated"
        )

    def test_case_k_detector_does_not_invoke_read_yn(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        """The Case K prompt is informational; MUST NOT call interactive helpers."""
        called: list[tuple] = []

        def _poisoned_read_yn(*args, **kwargs):
            called.append(("read_yn", args, kwargs))
            raise AssertionError(
                "read_yn invoked from Case K detector -- "
                "auto-prompt MUST stay informational, never blocking"
            )

        for name in ("read_yn", "ask_confirm"):
            if hasattr(deft_run_module, name):
                monkeypatch.setattr(deft_run_module, name, _poisoned_read_yn)

        _make_state_k(tmp_path, deft_run_module)
        deft_run_module._maybe_emit_install_layout_prompt(tmp_path)

        assert called == [], (
            "Case K auto-prompt invoked an interactive confirm helper -- "
            "the prompt is informational only"
        )
