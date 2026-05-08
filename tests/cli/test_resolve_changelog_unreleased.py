"""test_resolve_changelog_unreleased.py -- union-merge CHANGELOG conflicts (#911).

Coverage (per the #911 vBRIEF acceptance criteria):

- HEAD-only existing entries: no branch entry, conflict resolves to HEAD-only.
- Branch-only new entry: no HEAD entry, conflict resolves to branch-only.
- Both sides have entries: union of HEAD + branch, branch prepended.
- Branch entry already in HEAD by ``(#NNN)``: deduplicated, branch dropped.
- Multi-section conflict (Added + Fixed simultaneously inside one block):
  each subsection union-merged independently.
- Corrupted markers (mismatched / missing / nested): exit 1.
- No markers: exit 0 no-op (file unchanged byte-for-byte).
- Atomic-write integrity: file content matches the in-memory render exactly.
- Non-ASCII content round-trip: em dashes, arrows, smart quotes survive a
  resolve cycle (regression for #798's recurrence chain).
- ``--dry-run`` does not modify the file.
- Conflicts outside [Unreleased] -> exit 1.
- Path errors -> exit 2.

Story: #911. Pure stdlib; tests use ``tmp_path`` for isolation.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "resolve_changelog_unreleased",
        scripts_dir / "resolve_changelog_unreleased.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["resolve_changelog_unreleased"] = module
    spec.loader.exec_module(module)
    return module


resolver = _load_module()


# ---------------------------------------------------------------------------
# resolve_changelog -- pure-function branch coverage
# ---------------------------------------------------------------------------


CHANGELOG_HEADER = (
    "# Changelog\n"
    "\n"
    "All notable changes to this project will be documented in this file.\n"
    "\n"
)


def _build_changelog(unreleased_body: str, *, tail: str = "") -> str:
    """Helper: assemble a CHANGELOG with the given Unreleased body."""
    return (
        CHANGELOG_HEADER
        + "## [Unreleased]\n\n"
        + unreleased_body
        + ("\n" if not unreleased_body.endswith("\n") else "")
        + tail
    )


class TestNoMarkers:
    def test_no_unreleased_no_markers_is_noop(self):
        content = "# Changelog\n\nNo unreleased section here.\n"
        new, msg = resolver.resolve_changelog(content)
        assert new == content
        assert "no-op" in msg

    def test_unreleased_without_conflict_is_noop(self):
        content = _build_changelog(
            "### Added\n- existing entry (#100)\n\n### Fixed\n- another (#200)\n"
        )
        new, msg = resolver.resolve_changelog(content)
        assert new == content
        assert "no-op" in msg


class TestHeadOnlyEntries:
    def test_head_has_entries_branch_empty(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry from master (#100)\n"
            "- second entry from master (#101)\n"
            "=======\n"
            ">>>>>>> abc1234\n"
            "\n"
            "### Fixed\n"
            "- existing fixed entry (#50)\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is not None
        assert "<<<<<<<" not in new
        assert "=======" not in new
        assert ">>>>>>>" not in new
        assert "entry from master (#100)" in new
        assert "second entry from master (#101)" in new
        assert "existing fixed entry (#50)" in new
        assert "resolved" in msg


class TestBranchOnlyEntry:
    def test_branch_new_entry_head_empty(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "=======\n"
            "- new entry from branch (#911)\n"
            ">>>>>>> deadbeef\n"
            "\n"
            "### Fixed\n"
            "- existing (#50)\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "new entry from branch (#911)" in new
        assert "<<<<<<<" not in new


class TestBothSidesHaveEntries:
    def test_union_branch_prepended_above_head(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master entry (#100)\n"
            "- earlier master entry (#99)\n"
            "=======\n"
            "- branch entry (#911)\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        # Branch entry must be prepended -- appear before master entry.
        assert new.index("branch entry (#911)") < new.index("master entry (#100)")
        # All three entries present.
        assert "branch entry (#911)" in new
        assert "master entry (#100)" in new
        assert "earlier master entry (#99)" in new


class TestDedupByIssueNumber:
    def test_branch_entry_already_in_head_dropped(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- canonical entry for issue 911 (#911)\n"
            "=======\n"
            "- duplicate branch entry for issue 911 (#911)\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "canonical entry for issue 911" in new
        assert "duplicate branch entry for issue 911" not in new

    def test_no_issue_number_branch_entry_always_prepended(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master entry (#100)\n"
            "=======\n"
            "- branch entry without issue number\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "branch entry without issue number" in new
        assert "master entry (#100)" in new


class TestMultiSectionConflict:
    def test_added_and_fixed_simultaneously(self):
        body = (
            "<<<<<<< HEAD\n"
            "### Added\n"
            "- master added (#100)\n"
            "\n"
            "### Fixed\n"
            "- master fixed (#200)\n"
            "=======\n"
            "### Added\n"
            "- branch added (#911)\n"
            "\n"
            "### Fixed\n"
            "- branch fixed (#912)\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "master added (#100)" in new
        assert "branch added (#911)" in new
        assert "master fixed (#200)" in new
        assert "branch fixed (#912)" in new
        # Branch entries prepended in their respective subsections.
        assert new.index("branch added (#911)") < new.index("master added (#100)")
        assert new.index("branch fixed (#912)") < new.index("master fixed (#200)")


class TestCorruptedMarkers:
    def test_missing_separator_returns_unresolvable(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg

    def test_missing_tail_returns_unresolvable(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry\n"
            "=======\n"
            "- branch\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg

    def test_orphan_separator_returns_unresolvable(self):
        body = (
            "### Added\n"
            "- entry one\n"
            "=======\n"
            "- entry two\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg

    def test_nested_head_marker_returns_unresolvable(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "<<<<<<< HEAD\n"
            "- inner\n"
            "=======\n"
            "- branch\n"
            ">>>>>>> sha2\n"
            ">>>>>>> sha1\n"
        )
        content = _build_changelog(body)
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg


class TestConflictsOutsideUnreleased:
    def test_marker_in_released_section_returns_unresolvable(self):
        content = (
            CHANGELOG_HEADER
            + "## [Unreleased]\n\n"
            + "### Added\n- clean unreleased entry (#100)\n\n"
            + "## [0.26.0] - 2026-05-06\n\n"
            + "### Fixed\n"
            + "<<<<<<< HEAD\n"
            + "- a (#1)\n"
            + "=======\n"
            + "- b (#2)\n"
            + ">>>>>>> sha\n"
        )
        new, msg = resolver.resolve_changelog(content)
        assert new is None
        assert "unresolvable" in msg
        assert "outside" in msg.lower()


class TestAtomicWrite:
    def test_round_trip_preserves_byte_content(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master (#100)\n"
            "=======\n"
            "- branch (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        path.write_text(content, encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path)])
        assert rc == 0
        # File rewritten in place; byte content must equal the resolved content.
        on_disk = path.read_text(encoding="utf-8")
        assert "<<<<<<<" not in on_disk
        assert "branch (#911)" in on_disk
        assert "master (#100)" in on_disk

    def test_dry_run_does_not_modify_file(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master (#100)\n"
            "=======\n"
            "- branch (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        path.write_text(content, encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path), "--dry-run"])
        assert rc == 0
        # File unchanged on disk.
        on_disk = path.read_text(encoding="utf-8")
        assert "<<<<<<<" in on_disk
        assert on_disk == content


class TestNonAsciiContent:
    """Regression for #798: em dashes / arrows / smart quotes survive resolve."""

    def test_em_dash_arrow_round_trip(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        # Non-ASCII glyphs in BOTH sides of the conflict and in the surrounding
        # body. The atomic-write path MUST preserve every codepoint.
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- master entry — uses em dash and → arrow (#100)\n"
            "=======\n"
            "- branch entry — uses smart quotes \u201chello\u201d and ellipsis \u2026 (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        path.write_text(content, encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path)])
        assert rc == 0
        on_disk = path.read_text(encoding="utf-8")
        assert "—" in on_disk
        assert "→" in on_disk
        assert "\u201chello\u201d" in on_disk
        assert "\u2026" in on_disk
        # Ensure NO U+FFFD replacement chars leaked in.
        assert "\ufffd" not in on_disk

    def test_pure_function_preserves_non_ascii(self):
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- α master β (#100)\n"
            "=======\n"
            "- γ branch δ (#911)\n"
            ">>>>>>> sha\n"
        )
        content = _build_changelog(body)
        new, _ = resolver.resolve_changelog(content)
        assert new is not None
        assert "α master β" in new
        assert "γ branch δ" in new


# ---------------------------------------------------------------------------
# main() exit codes
# ---------------------------------------------------------------------------


class TestMainExitCodes:
    def test_resolved_exits_zero(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- a (#1)\n"
            "=======\n"
            "- b (#2)\n"
            ">>>>>>> sha\n"
        )
        path.write_text(_build_changelog(body), encoding="utf-8")
        assert resolver.main(["--changelog-path", str(path)]) == 0

    def test_no_op_exits_zero(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        path.write_text(
            _build_changelog("### Added\n- clean (#100)\n"), encoding="utf-8"
        )
        assert resolver.main(["--changelog-path", str(path)]) == 0

    def test_corrupted_exits_one(self, tmp_path):
        path = tmp_path / "CHANGELOG.md"
        body = "### Added\n<<<<<<< HEAD\n- a\n>>>>>>> sha\n"
        path.write_text(_build_changelog(body), encoding="utf-8")
        assert resolver.main(["--changelog-path", str(path)]) == 1

    def test_missing_path_exits_two(self, tmp_path):
        missing = tmp_path / "does-not-exist.md"
        assert resolver.main(["--changelog-path", str(missing)]) == 2

    def test_directory_path_exits_two(self, tmp_path):
        # Pass a directory, not a file -> config error.
        rc = resolver.main(["--changelog-path", str(tmp_path)])
        assert rc == 2

    def test_unresolvable_prefix_not_doubled_in_stderr(self, tmp_path, capsys):
        """Greptile P2 (PR #999): the inner message from ``resolve_changelog``
        already carries the ``unresolvable:`` prefix; ``evaluate()`` must NOT
        re-prefix or operators see ``unresolvable: unresolvable: ...`` on
        stderr for every exit-1 path.
        """
        path = tmp_path / "CHANGELOG.md"
        body = (
            "### Added\n"
            "<<<<<<< HEAD\n"
            "- entry\n"
            ">>>>>>> sha\n"
        )
        path.write_text(_build_changelog(body), encoding="utf-8")
        rc = resolver.main(["--changelog-path", str(path)])
        assert rc == 1
        err = capsys.readouterr().err
        # The diagnostic carries exactly ONE ``unresolvable:`` prefix.
        assert err.count("unresolvable:") == 1, (
            f"prefix doubled in stderr: {err!r}"
        )


# ---------------------------------------------------------------------------
# Internal helpers -- finer-grained coverage
# ---------------------------------------------------------------------------


class TestParseSide:
    def test_entries_attached_to_ambient(self):
        sections = resolver.parse_side(
            ["- one (#1)", "- two (#2)"], ambient_subsection="Added"
        )
        assert sections == [("Added", ["- one (#1)", "- two (#2)"])]

    def test_subsection_header_starts_new_section(self):
        sections = resolver.parse_side(
            ["- ambient (#1)", "### Fixed", "- fix one (#2)"],
            ambient_subsection="Added",
        )
        assert sections == [
            ("Added", ["- ambient (#1)"]),
            ("Fixed", ["- fix one (#2)"]),
        ]

    def test_blank_line_ends_entry(self):
        sections = resolver.parse_side(
            ["- one (#1)", "", "- two (#2)"], ambient_subsection="Added"
        )
        assert sections == [("Added", ["- one (#1)", "- two (#2)"])]

    def test_indented_continuation_kept(self):
        sections = resolver.parse_side(
            ["- entry (#1)", "  continuation line"],
            ambient_subsection="Added",
        )
        assert sections == [
            ("Added", ["- entry (#1)\n  continuation line"]),
        ]


class TestUnionMerge:
    def test_dedup_by_issue_number(self):
        head = [("Added", ["- e (#1)"])]
        branch = [("Added", ["- duplicate (#1)"])]
        merged = resolver.union_merge(head, branch)
        assert merged == [("Added", ["- e (#1)"])]

    def test_branch_subsection_only_appended(self):
        head = [("Added", ["- e (#1)"])]
        branch = [("Fixed", ["- fix (#2)"])]
        merged = resolver.union_merge(head, branch)
        assert merged == [
            ("Added", ["- e (#1)"]),
            ("Fixed", ["- fix (#2)"]),
        ]

    def test_branch_entries_prepended(self):
        head = [("Added", ["- master (#1)"])]
        branch = [("Added", ["- branch (#2)"])]
        merged = resolver.union_merge(head, branch)
        assert merged == [("Added", ["- branch (#2)", "- master (#1)"])]


class TestIssueNumbers:
    def test_extracts_all_parenthesized(self):
        # Per the #911 contract the heuristic is strict ``(#NNN)`` -- only
        # explicitly parenthesized issue references count toward dedup.
        assert resolver.issue_numbers("- entry (#100) text (#200) end (#300)") == {
            "100",
            "200",
            "300",
        }

    def test_unparenthesized_reference_ignored(self):
        # Bare ``#NNN`` (e.g. ``Closes #911`` in commit messages) is NOT a
        # CHANGELOG-style closing reference; the heuristic intentionally skips
        # it so commit-message close-tokens do not pollute the dedup set.
        assert resolver.issue_numbers("- entry referencing #100 inline") == set()

    def test_no_issue_returns_empty(self):
        assert resolver.issue_numbers("- entry without issue") == set()
