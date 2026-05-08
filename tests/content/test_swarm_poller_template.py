"""Regression tests for the triple-tier Greptile findings detector baked into
``templates/swarm-greptile-poller-prompt.md`` (#910).

The template body prescribes the detector that every dispatched poller agent
copies into its poll script. Three independent surface forms have been
observed in the wild during the v0.25.1 swarm session (2026-05-04):

1. **Tier 1**  -- HTML severity badges (``<img alt="P0"`` / ``<img alt="P1"``).
2. **Tier 2**  -- markdown-bullet bold (``- **P1 -- ...**``).
3. **Tier 3**  -- inline prose (``Three P1 findings ...``, ``Not safe to merge``,
   ``^P1 -- ...``).

Three false-negatives in a single swarm session (#907 first review, #908 first
review, #908 retrigger) drove the move from a badge-only detector to the
triple-tier detector. These tests pin the regression so a future template edit
that drops or weakens any tier fails CI immediately.

The tests exercise a Python *reference implementation* of the detector (mirror
of the template body) AND assert the template still contains the canonical
regex strings / sentinels so the two stay in sync.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE_PATH = REPO_ROOT / "templates" / "swarm-greptile-poller-prompt.md"


# ---------------------------------------------------------------------------
# Reference detector implementation -- mirrors the template body.
# Any change here MUST be mirrored in templates/swarm-greptile-poller-prompt.md
# (and vice-versa). The synchronization tests below assert that the canonical
# regex strings and sentinels are present in the template verbatim.
# ---------------------------------------------------------------------------

_TIER2_RE = re.compile(r"^[\s\-\*]*\*\*P([01])\b[^*]*\*\*", re.MULTILINE)
_TIER2_NEGATIONS = ("No ", "Zero ", "0 ", "no ")

_TIER3_COUNT_RE = re.compile(
    r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b",
    re.IGNORECASE,
)
_TIER3_LINE_RE = re.compile(r"^\s*P[01]\s+--\s", re.MULTILINE)
_TIER3_NEGATIONS = ("No ", "Zero ", "no ", "NO ")


def _line_for(body: str, pos: int) -> str:
    line_start = body.rfind("\n", 0, pos) + 1
    line_end = body.find("\n", pos)
    return body[line_start : line_end if line_end != -1 else len(body)]


def detect(body: str) -> dict:
    """Triple-tier detector reference implementation.

    Returns a dict with ``tier1_p0`` / ``tier1_p1`` / ``tier2_p0`` /
    ``tier2_p1`` / ``tier3_sentinel`` / ``p0_count`` / ``p1_count`` /
    ``has_blocking`` so individual tier contributions are inspectable in
    test failure messages.
    """
    tier1_p0 = body.count('<img alt="P0"')
    tier1_p1 = body.count('<img alt="P1"')

    tier2_p0 = 0
    tier2_p1 = 0
    for m in _TIER2_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER2_NEGATIONS):
            continue
        if m.group(1) == "0":
            tier2_p0 += 1
        else:
            tier2_p1 += 1

    tier3_sentinel = False
    if "Not safe to merge" in body:
        tier3_sentinel = True
    if not tier3_sentinel:
        for m in _TIER3_COUNT_RE.finditer(body):
            line = _line_for(body, m.start())
            if any(neg in line for neg in _TIER3_NEGATIONS):
                continue
            if re.match(r"\s*0\b", m.group(0)):
                continue
            tier3_sentinel = True
            break
    if not tier3_sentinel:
        for m in _TIER3_LINE_RE.finditer(body):
            line = _line_for(body, m.start())
            if any(neg in line for neg in _TIER3_NEGATIONS):
                continue
            tier3_sentinel = True
            break

    p0_count = max(tier1_p0, tier2_p0)
    p1_count = max(tier1_p1, tier2_p1)
    has_blocking = (p0_count + p1_count) > 0 or tier3_sentinel
    return {
        "tier1_p0": tier1_p0,
        "tier1_p1": tier1_p1,
        "tier2_p0": tier2_p0,
        "tier2_p1": tier2_p1,
        "tier3_sentinel": tier3_sentinel,
        "p0_count": p0_count,
        "p1_count": p1_count,
        "has_blocking": has_blocking,
    }


# ---------------------------------------------------------------------------
# Synthetic Greptile bodies covering the three observed surface forms.
# ---------------------------------------------------------------------------

BODY_TIER2_P1_ONLY = """\
Greptile review of head 1234567

Confidence Score: 4/5

Last reviewed commit: [fix: foo bar](https://github.com/deftai/directive/commit/abcdef1234567)

Comments:

- **P1 -- wrong exception type for state/limit validation in populate()**
  The current code raises ValueError but the contract calls for InvalidRepoError.
- **P2 -- minor wording in error message**
  Consider `--repo` instead of `the repo flag`.
"""

BODY_TIER3_NOT_SAFE_ONLY = """\
Greptile review of head 7654321

Confidence Score: 3/5

Last reviewed commit: [refactor: thing](https://github.com/deftai/directive/commit/0011223344556)

Summary: Not safe to merge until the mocked-import test defect and the two
previously filed P1s are resolved.
"""

BODY_TIER3_COUNT_PROSE_ONLY = """\
Greptile review of head deadbeef

Confidence Score: 4/5

Last reviewed commit: [chore: bump](https://github.com/deftai/directive/commit/deadbeefcafe123)

Three P1 findings (two from prior review, one new): wrong exception type for
state/limit validation in populate(), misleading skip message, and an
unguarded import that will fail on Windows.
"""

BODY_NEGATION_GUARDED = """\
Greptile review of head ffffffff

Confidence Score: 5/5

Last reviewed commit: [feat: clean](https://github.com/deftai/directive/commit/ffffffffabc1234)

Summary: No P0 findings. Zero P1 findings. The PR is ready for merge.
"""

BODY_CLEAN = """\
Greptile review of head 1111111

Confidence Score: 5/5

Last reviewed commit: [docs: tweak](https://github.com/deftai/directive/commit/1111111aaa2222b)

No P0 or P1 issues found. The change looks clean and well-tested.
"""

BODY_TIER1_BADGES_ONLY = """\
Greptile review of head 2222222

Confidence Score: 3/5

Last reviewed commit: [fix: thing](https://github.com/deftai/directive/commit/2222222ccc3333d)

<img alt="P1" src="https://example.com/p1.png"> wrong exception type in populate()
<img alt="P1" src="https://example.com/p1.png"> misleading skip message
<img alt="P0" src="https://example.com/p0.png"> data-loss risk in cache eviction
"""


# ---------------------------------------------------------------------------
# Regression tests -- six required cases per #910 acceptance criteria.
# ---------------------------------------------------------------------------


def test_tier2_markdown_bullet_p1_only_triggers_blocking() -> None:
    """Synthetic body with markdown-bullet P1 only (zero badges) MUST fire."""
    result = detect(BODY_TIER2_P1_ONLY)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p1"] >= 1, (
        f"tier2 should detect markdown-bullet P1, got {result!r}"
    )
    assert result["has_blocking"] is True, (
        f"markdown-bullet P1 must trigger has_blocking=True, got {result!r}"
    )


def test_tier3_not_safe_to_merge_sentinel_only_triggers_blocking() -> None:
    """Body with `Not safe to merge` only (no badges, no markdown bullets) MUST fire."""
    result = detect(BODY_TIER3_NOT_SAFE_ONLY)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is True
    assert result["has_blocking"] is True


def test_tier3_count_prose_three_p1_findings_triggers_blocking() -> None:
    """Body with `Three P1 findings` count-prose only MUST fire."""
    result = detect(BODY_TIER3_COUNT_PROSE_ONLY)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is True
    assert result["has_blocking"] is True


def test_negation_guard_no_p0_zero_p1_does_not_trigger() -> None:
    """`No P0 findings` / `Zero P1 findings` MUST NOT trigger has_blocking."""
    result = detect(BODY_NEGATION_GUARDED)
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is False, (
        f"negation-guarded prose must NOT fire tier3 sentinel, got {result!r}"
    )
    assert result["has_blocking"] is False


def test_clean_body_no_findings_does_not_trigger() -> None:
    """Clean body with no findings MUST produce has_blocking=False."""
    result = detect(BODY_CLEAN)
    assert result["has_blocking"] is False
    assert result["p0_count"] == 0
    assert result["p1_count"] == 0


def test_tier1_pure_badge_body_still_triggers() -> None:
    """Tier-1 badge-only body MUST still produce has_blocking=True (regression)."""
    result = detect(BODY_TIER1_BADGES_ONLY)
    assert result["tier1_p0"] == 1
    assert result["tier1_p1"] == 2
    assert result["has_blocking"] is True


# ---------------------------------------------------------------------------
# Synchronization tests -- assert the template encodes the same regex
# strings / sentinels the reference implementation above uses. If a future
# edit weakens or removes a tier from the template, these tests fail and
# force the author to update the reference + tests in lockstep.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def template_text() -> str:
    return TEMPLATE_PATH.read_text(encoding="utf-8")


def test_template_contains_tier2_regex(template_text: str) -> None:
    """Template MUST encode the markdown-bullet bold regex with negation guards."""
    assert (
        r"^[\s\-\*]*\*\*P([01])\b[^*]*\*\*"
        in template_text
    ), "template missing Tier 2 markdown-bullet regex (#910)"
    # All four negation tokens must be enumerated.
    for token in ('"No "', '"Zero "', '"0 "', '"no "'):
        assert token in template_text, (
            f"template Tier 2 negation list missing token {token!r} (#910)"
        )


def test_template_contains_tier3_count_prose_regex(template_text: str) -> None:
    """Template MUST encode the inline-prose count regex (One..Ten|\\d+ P[01] findings)."""
    assert (
        r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b"
        in template_text
    ), "template missing Tier 3 count-prose regex (#910)"


def test_template_contains_tier3_line_anchored_regex(template_text: str) -> None:
    """Template MUST encode the line-anchored ``^P[01] -- `` sentinel regex."""
    assert (
        r"^\s*P[01]\s+--\s"
        in template_text
    ), "template missing Tier 3 line-anchored regex (#910)"


def test_template_contains_not_safe_to_merge_substring(template_text: str) -> None:
    """Template MUST encode the ``Not safe to merge`` substring sentinel."""
    assert "Not safe to merge" in template_text, (
        "template missing Tier 3 `Not safe to merge` substring sentinel (#910)"
    )


def test_template_contains_tier1_badge_count_strings(template_text: str) -> None:
    """Template MUST encode the canonical Tier 1 HTML-badge substring counts.

    Greptile review on PR #996 surfaced this gap: the Tier 2 / Tier 3 sync
    tests pin their regex strings, but nothing pinned the Tier 1
    ``body.count('<img alt="P0"')`` / ``body.count('<img alt="P1"')`` calls
    that drive the badge tier. A future editor renaming the HTML attribute
    (e.g. switching to ``data-severity="P0"`` or upstream Greptile changing
    the badge tag) would silently break Tier 1 with no sync-test failure.
    Pin both calls verbatim.
    """
    assert (
        "body.count('<img alt=\"P0\"')" in template_text
    ), "template missing Tier 1 badge count for P0 (`body.count('<img alt=\"P0\"')`) (#910)"
    assert (
        "body.count('<img alt=\"P1\"')" in template_text
    ), "template missing Tier 1 badge count for P1 (`body.count('<img alt=\"P1\"')`) (#910)"


def test_template_combined_verdict_uses_max_per_severity(template_text: str) -> None:
    """Template MUST combine tier1+tier2 via max() per severity (no double-counting)."""
    assert "max(tier1_p0, tier2_p0)" in template_text
    assert "max(tier1_p1, tier2_p1)" in template_text
    assert "tier3_sentinel" in template_text


def test_template_section_heading_marks_triple_tier(template_text: str) -> None:
    """Template section heading MUST advertise the triple-tier upgrade + #910."""
    assert "TRIPLE-TIER" in template_text
    assert "#910" in template_text


def test_template_recurrence_record_three_false_negatives(template_text: str) -> None:
    """Template MUST cite the v0.25.1 swarm session three-false-negative record."""
    # The recurrence count is the load-bearing argument for promoting Tier 2
    # and Tier 3 from Notes-only to detector-body. If a future edit drops the
    # recurrence citation the rule body's rationale evaporates -- pin it.
    assert "three false-negatives" in template_text.lower() or (
        "three false-negative" in template_text.lower()
    ), "template must cite the three-false-negative recurrence record (#910)"


def test_template_renders_via_format() -> None:
    """The template MUST still render via str.format() with all five placeholders.

    Structural guard against accidentally introducing an unescaped `{` in the
    new triple-tier code block (every literal curly brace must be doubled).
    """
    text = TEMPLATE_PATH.read_text(encoding="utf-8")
    rendered = text.format(
        pr_number=910,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id-xyz",
    )
    assert "PR #910" in rendered
    assert "deftai/directive" in rendered
