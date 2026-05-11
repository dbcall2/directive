"""Regression tests for the Greptile / SLizard findings detector baked into
``templates/swarm-greptile-poller-prompt.md`` (#910 + #1035).

The template body prescribes the detector that every dispatched poller agent
copies into its poll script. Four independent surface forms have been
observed in the wild across two recurrence events:

1. **Tier 1**   -- HTML severity badges (``<img alt="P0"`` / ``<img alt="P1"``).
2. **Tier 2**   -- markdown-bullet bold (``- **P1 -- ...**``).
3. **Tier 2.5** -- SLizard `### P[01] · ...` heading form (#1035, PR #1034).
4. **Tier 3**   -- inline prose (``Three P1 findings ...``, ``Not safe to merge``,
   ``^P1 -- ...``).

Three false-negatives in the v0.25.1 swarm session (#907 first review, #908
first review, #908 retrigger) drove the move from a badge-only detector to the
triple-tier detector under #910. A subsequent live miss on PR #1034
(2026-05-11, #1035) -- where SLizard rendered a P1 finding as a `### P1 ·`
heading paired with a `## Confidence Score: 3/5` markdown header -- drove the
Tier 2.5 + confidence-heading parser fallback in this module. These tests pin
both regressions so a future template edit that drops or weakens any tier
fails CI immediately.

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

# Tier 2.5 (#1035) -- SLizard `### P[01] <sep> ...` heading-form findings.
# Separator class: middot U+00B7, hyphenation point U+2027, bullet U+2022,
# ASCII hyphen. The hyphen is placed last in the char class so it is treated
# as a literal hyphen rather than a range delimiter.
_TIER25_RE = re.compile(
    r"^#{1,6}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s", re.MULTILINE
)

_TIER3_COUNT_RE = re.compile(
    r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b",
    re.IGNORECASE,
)
_TIER3_LINE_RE = re.compile(r"^\s*P[01]\s+--\s", re.MULTILINE)
_TIER3_NEGATIONS = ("No ", "Zero ", "no ", "NO ")

# Confidence parse (#1035) -- the inline-or-line form matches both inline prose
# and most heading forms by virtue of being unanchored. The heading-form
# fallback is the strictly-anchored ^...$ multiline regex used only when the
# inline form does not match -- a defence-in-depth structural guard against
# heading lines that carry trailing markup or whitespace the inline regex
# declines.
_CONFIDENCE_INLINE_RE = re.compile(r"Confidence Score:\s*(\d+)\s*/\s*5")
_CONFIDENCE_HEADING_RE = re.compile(
    r"^#{1,6}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$", re.MULTILINE
)


def parse_confidence(body: str):
    """Reference confidence parser mirroring the template body.

    Returns the integer score on match (including ``0``), or ``None`` if
    neither regex matches. The heading-form fallback only fires when the
    inline regex returns None, mirroring the template's two-step parse.
    """
    m = _CONFIDENCE_INLINE_RE.search(body)
    if m is None:
        m = _CONFIDENCE_HEADING_RE.search(body)
    return int(m.group(1)) if m else None


def _line_for(body: str, pos: int) -> str:
    line_start = body.rfind("\n", 0, pos) + 1
    line_end = body.find("\n", pos)
    return body[line_start : line_end if line_end != -1 else len(body)]


def detect(body: str) -> dict:
    """Greptile / SLizard findings detector reference implementation.

    Mirrors the template body (#910 triple-tier + #1035 Tier 2.5). Returns a
    dict with ``tier1_p0`` / ``tier1_p1`` / ``tier2_p0`` / ``tier2_p1`` /
    ``tier25_p0`` / ``tier25_p1`` / ``tier3_sentinel`` / ``p0_count`` /
    ``p1_count`` / ``has_blocking`` so individual tier contributions are
    inspectable in test failure messages.
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

    tier25_p0 = 0
    tier25_p1 = 0
    for m in _TIER25_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER2_NEGATIONS):
            continue
        if m.group(1) == "0":
            tier25_p0 += 1
        else:
            tier25_p1 += 1

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

    p0_count = max(tier1_p0, tier2_p0, tier25_p0)
    p1_count = max(tier1_p1, tier2_p1, tier25_p1)
    has_blocking = (p0_count + p1_count) > 0 or tier3_sentinel
    return {
        "tier1_p0": tier1_p0,
        "tier1_p1": tier1_p1,
        "tier2_p0": tier2_p0,
        "tier2_p1": tier2_p1,
        "tier25_p0": tier25_p0,
        "tier25_p1": tier25_p1,
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

# Tier 2.5 (#1035) -- SLizard rolling-summary comment with `### P1 · ...`
# heading-form finding and a `## Confidence Score: 3/5` markdown heading.
# Faithful reproduction of the PR #1034 (2026-05-11) live miss: zero Tier 1
# badges, zero Tier 2 `**...**` markdown-bullet bold, zero Tier 3 `Not safe
# to merge` / count-prose / `^P[01] -- ` line. Without Tier 2.5 the
# detector returns has_blocking=False AND the poller silently falls through.
BODY_SLIZARD_HEADING_P1 = (
    "SLizard review of head 3333333\n"
    "\n"
    "## Confidence Score: 3/5\n"
    "\n"
    "Decision: request_changes\n"
    "Severity counts: P0: 0, P1: 1\n"
    "\n"
    "### P1 \u00b7 Inaccurate description claim about ROADMAP.md `## Active` section\n"
    "The PR body claims the ROADMAP.md '## Active' section but the section\n"
    "does not exist at HEAD; verify the claim before merge.\n"
    "\n"
    "Last reviewed commit: [fix: stuff](https://github.com/deftai/directive/commit/3333333abcdef12)\n"
)

# Tier 2.5 (#1035) negation-context guard regression -- a heading that uses
# the SLizard separator BUT the same physical line carries a negation token
# (`No `, `Zero `, `0 `, lowercase `no `) MUST NOT count toward has_blocking.
# Synthetic; the live SLizard surface rarely renders this form but the guard
# parity with Tier 2 is a structural invariant.
BODY_SLIZARD_HEADING_NEGATION = (
    "SLizard review of head 4444444\n"
    "\n"
    "## Confidence Score: 5/5\n"
    "\n"
    "Decision: comment\n"
    "Severity counts: P0: 0, P1: 0\n"
    "\n"
    "### No P1 \u00b7 findings -- clean review\n"
    "\n"
    "Last reviewed commit: [docs: thing](https://github.com/deftai/directive/commit/4444444abcdef12)\n"
)

# Confidence-heading parser (#1035) -- a body whose ONLY Confidence Score
# anchor is a markdown heading. The inline regex `re.search` happens to
# match this body too (because it is unanchored), but the test pairs the
# inline form's match against the heading-form fallback's match to assert
# both surfaces parse to the same numeric value (3) -- the structural
# defence-in-depth contract.
BODY_CONFIDENCE_HEADING_ONLY = (
    "SLizard review of head 5555555\n"
    "\n"
    "## Confidence Score: 3/5\n"
    "\n"
    "Some body text without inline confidence prose.\n"
    "\n"
    "Last reviewed commit: [fix: x](https://github.com/deftai/directive/commit/5555555abcdef12)\n"
)


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
# Regression tests -- #1035 acceptance criteria (Tier 2.5 SLizard heading
# form + confidence-heading parser fallback). Each test pins one of the
# acceptance criteria AC-1 / AC-2 / AC-2-negation-guard so a future edit
# that weakens the detector fails CI immediately.
# ---------------------------------------------------------------------------


def test_negative_control_pre_tier25_detector_misses_slizard_heading() -> None:
    """Negative-control: the pre-#1035 Tier 1/2/3 triple-tier detector misses
    SLizard `### P1 \u00b7 ...` heading-form findings entirely.

    This test pins the failure-mode signature so a future change that
    accidentally drops Tier 2.5 falls back to the pre-#1035 detector
    behaviour and fails this assertion (along with the positive Tier 2.5
    test below).
    """
    result = detect(BODY_SLIZARD_HEADING_P1)
    # Pre-#1035 tiers: all zero on the SLizard heading body.
    assert result["tier1_p0"] == 0
    assert result["tier1_p1"] == 0
    assert result["tier2_p0"] == 0
    assert result["tier2_p1"] == 0
    assert result["tier3_sentinel"] is False, (
        "SLizard heading body must NOT trip Tier 3 (no `Not safe to merge`, "
        f"no count-prose, no `^P[01] -- ` line); got {result!r}"
    )


def test_tier25_slizard_heading_p1_triggers_blocking() -> None:
    """AC-2: SLizard `### P1 \u00b7 ...` heading-form finding MUST fire."""
    result = detect(BODY_SLIZARD_HEADING_P1)
    assert result["tier25_p1"] == 1, (
        f"Tier 2.5 should detect SLizard heading-form P1, got {result!r}"
    )
    assert result["tier25_p0"] == 0
    assert result["p1_count"] == 1
    assert result["has_blocking"] is True, (
        f"SLizard heading-form P1 must trigger has_blocking=True, got {result!r}"
    )


def test_tier25_negation_guard_rejects_no_p1_heading() -> None:
    """AC-2 negation guard: `### No P1 \u00b7 findings` MUST NOT trigger."""
    result = detect(BODY_SLIZARD_HEADING_NEGATION)
    assert result["tier25_p0"] == 0
    assert result["tier25_p1"] == 0, (
        f"Tier 2.5 negation guard must reject `No P1 \u00b7 ...` heading, "
        f"got {result!r}"
    )
    assert result["has_blocking"] is False


def test_confidence_heading_form_parses_to_same_score_as_inline() -> None:
    """AC-1: both inline and heading-form confidence regexes MUST parse to the
    same numeric score for the same body.

    The inline regex is unanchored and so happens to also match a heading
    line, but the heading-form fallback is the load-bearing defence-in-depth
    contract. Drive each regex in isolation so a future edit that breaks the
    heading-form regex fails this assertion even when the inline regex still
    happens to match.
    """
    body = BODY_CONFIDENCE_HEADING_ONLY
    inline_match = _CONFIDENCE_INLINE_RE.search(body)
    heading_match = _CONFIDENCE_HEADING_RE.search(body)
    assert inline_match is not None, (
        "inline regex should still match a markdown heading because it is "
        "unanchored -- the heading-form fallback is defence-in-depth"
    )
    assert heading_match is not None, (
        "heading-form fallback MUST match `## Confidence Score: 3/5`"
    )
    assert int(inline_match.group(1)) == int(heading_match.group(1)) == 3
    assert parse_confidence(body) == 3


def test_confidence_heading_form_only_parses_when_inline_misses() -> None:
    """AC-1: when the inline regex cannot match (synthetic adversarial body),
    the heading-form fallback MUST still parse the score.

    Construct a body where the only `Confidence Score:` anchor is preceded
    by hash glyphs that the inline regex tolerates BUT pad the inline form
    out of reach with leading hash glyphs and verify the parser still
    returns 4 via the heading-form fallback. Because the inline regex is
    unanchored it cannot easily be defeated; assert the parser returns the
    correct score regardless of which surface fires.
    """
    body = "#### Confidence Score: 4/5\n\nbody text\n"
    assert parse_confidence(body) == 4


def test_confidence_zero_score_parses_via_slash_form() -> None:
    """AC-1 leading-`0` guard: `0/5` is a valid confidence and MUST parse.

    Conversely, a stray `0` outside the slash form MUST NOT trip the gate
    -- the regex structurally requires the `\\s*/\\s*5` suffix so any bare
    `0` cannot match. Pin both behaviours.
    """
    assert parse_confidence("## Confidence Score: 0/5\n") == 0
    # Stray `0` outside the slash form -- inline regex would not match either,
    # but the heading regex MUST also decline.
    body_stray = "## Confidence Score: 0 out of 5\n"
    assert _CONFIDENCE_HEADING_RE.search(body_stray) is None
    assert parse_confidence(body_stray) is None


def test_confidence_parses_inline_form_unchanged() -> None:
    """AC-1 regression: the inline-prose form MUST still parse unchanged.

    The heading-form fallback is added as a defence-in-depth fallback; the
    primary inline path must keep working on every previously-supported
    surface (no regression on the #910 / pre-#1035 bodies).
    """
    assert parse_confidence(BODY_TIER2_P1_ONLY) == 4
    assert parse_confidence(BODY_TIER3_NOT_SAFE_ONLY) == 3
    assert parse_confidence(BODY_CLEAN) == 5


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
    """Template MUST combine tier1+tier2+tier25 via max() per severity (#910 + #1035)."""
    assert "max(tier1_p0, tier2_p0, tier25_p0)" in template_text, (
        "template combined verdict must fold Tier 2.5 P0 into per-severity max() (#1035)"
    )
    assert "max(tier1_p1, tier2_p1, tier25_p1)" in template_text, (
        "template combined verdict must fold Tier 2.5 P1 into per-severity max() (#1035)"
    )
    assert "tier3_sentinel" in template_text


def test_template_contains_tier25_regex(template_text: str) -> None:
    """Template MUST encode the Tier 2.5 SLizard heading regex (#1035).

    The regex matches SLizard's `### P[01] <sep> ...` heading-form findings,
    where `<sep>` is one of middot (U+00B7), hyphenation point (U+2027),
    bullet (U+2022), or ASCII hyphen. The character class places the
    hyphen last to avoid range-delimiter parsing.

    The template is a ``str.format(...)`` payload, so the literal ``{1,6}``
    quantifier appears in the file as the doubled-brace escape ``{{1,6}}``
    (every literal curly brace in the file is doubled per the format
    contract). The sync test asserts the escaped form to match what the
    file actually contains.
    """
    # Doubled-brace form -- the on-disk template content
    assert (
        r"^#{{1,6}}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s"
        in template_text
    ), "template missing Tier 2.5 SLizard heading regex (#1035)"
    # And confirm the doubled-brace form renders to the single-brace form
    # via str.format() so a downstream poller script actually compiles the
    # canonical regex (defence-in-depth against a typo that escapes one
    # side and not the other).
    rendered = template_text.format(
        pr_number=1035,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id",
    )
    assert (
        r"^#{1,6}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s"
        in rendered
    ), "rendered template missing Tier 2.5 SLizard heading regex (#1035)"


def test_template_contains_confidence_heading_regex(template_text: str) -> None:
    """Template MUST encode the heading-form confidence fallback regex (#1035).

    Same doubled-brace contract as the Tier 2.5 sync test above: the
    template file contains ``{{1,6}}``; the rendered output contains
    ``{1,6}``. Pin both.
    """
    assert (
        r"^#{{1,6}}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$"
        in template_text
    ), "template missing confidence-heading fallback regex (#1035)"
    rendered = template_text.format(
        pr_number=1035,
        repo="deftai/directive",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="parent-id",
    )
    assert (
        r"^#{1,6}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$"
        in rendered
    ), "rendered template missing confidence-heading fallback regex (#1035)"


def test_template_tier25_recurrence_citation(template_text: str) -> None:
    """Template MUST cite the #1035 recurrence record for Tier 2.5.

    The recurrence-record citation is the load-bearing argument for adding
    Tier 2.5; if a future edit drops the citation the rule body's rationale
    evaporates. Pin both the issue-number citation and the `Tier 2.5` token.
    """
    assert "#1035" in template_text, (
        "template must cite the Tier 2.5 recurrence-record issue (#1035)"
    )
    assert "Tier 2.5" in template_text, (
        "template must name the Tier 2.5 sub-tier explicitly so the existing "
        "Tier 1/2/3 citations remain stable (#1035)"
    )


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
