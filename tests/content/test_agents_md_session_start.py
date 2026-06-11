"""Snapshot-style content tests for AGENTS.md #1149 consolidation.

Pins the N9 surface (Session-start ritual preamble, cache-as-authoritative
top-tier rule, triage-related Skill Routing entries, and the pre-`start_agent`
gate stack) so a future edit that silently drops one of the Wave-1 additions
fails CI.

Per the Rule Authority [AXIOM] in main.md, content tests on rule prose are
the lightest enforceable layer below deterministic gates. The companion
`test_agents_md.py` and `test_agents_md_preamble.py` cover earlier surfaces
(headless bypass, alignment confirmation, #954 multi-agent rules); this file
focuses on the Wave-1 N9 additions only.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
AGENTS_MD = REPO_ROOT / "AGENTS.md"


@pytest.fixture(scope="module")
def agents_md_text() -> str:
    return AGENTS_MD.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _extract_section(text: str, heading_pattern: str) -> str:
    """Return the body (including heading) of the first `##` section whose heading matches.

    Section ends at the next `##` heading or EOF.
    """
    pattern = re.compile(
        r"^##\s+" + heading_pattern + r".*?(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    return match.group(0) if match else ""


# ---------------------------------------------------------------------------
# 1. Session-start ritual header + #1348 two-tier verifier contract
# ---------------------------------------------------------------------------


def test_session_start_ritual_header_present(agents_md_text: str) -> None:
    """The '## Session-start ritual (#1149)' header must exist."""
    assert re.search(
        r"^##\s+Session-start ritual\s+\(#1149\)\s*$",
        agents_md_text,
        re.MULTILINE,
    ), "missing '## Session-start ritual (#1149)' header"


def test_session_start_ritual_documents_two_tier_verifier_order(
    agents_md_text: str,
) -> None:
    """The ritual section must surface quick-tier state before gated verification."""
    section = _extract_section(agents_md_text, r"Session-start ritual \(#1149\)")
    assert section, "Session-start ritual section not isolatable"
    p_start = section.find("`task session:start`")
    p_state = section.find(".deft/ritual-state.json")
    p_verify = section.find("`task verify:session-ritual -- --tier=gated`")
    p_doctor = section.find("`task doctor`")
    p_triage = section.find("`task triage:welcome`")
    assert 0 <= p_start < p_state < p_triage < p_verify < p_doctor, (
        "Session-start ritual two-tier markers out of order: "
        f"session_start={p_start}, state={p_state}, verify={p_verify}, "
        f"doctor={p_doctor}, triage={p_triage}"
    )
    assert "plan.policy.sessionRitualStalenessHours" in section
    assert "DEFT_SESSION_RITUAL_SKIP=1" in section
    assert "--defer step=reason" in section


def test_session_start_ritual_documents_d2_suppression_window(
    agents_md_text: str,
) -> None:
    """D2's 4-hour suppression window must remain documented after #1309 step 4 swap.

    `task triage:welcome` (default mode, #1309) subsumes the prior
    `task triage:summary` invocation and inherits D2's 4-hour suppression
    contract; the section must continue to surface the suppression window
    so consumers know repeat emissions are debounced.
    """
    section = _extract_section(agents_md_text, r"Session-start ritual \(#1149\)")
    assert re.search(r"4[ -]hour", section), (
        "Session-start ritual must document the D2 4-hour suppression window "
        "(suppress repeat emission within 4 hours unless cache state changed; "
        "#1309 step 4 swap to `task triage:welcome` inherits the same contract)"
    )


def test_session_start_ritual_marks_cache_fresh_as_stale_only(
    agents_md_text: str,
) -> None:
    """The verify:cache-fresh line must indicate the warning is printed only when stale."""
    section = _extract_section(agents_md_text, r"Session-start ritual \(#1149\)")
    assert "stale" in section.lower(), (
        "Session-start ritual must note that `task verify:cache-fresh` is printed only "
        "when the cache is stale (D5 / #1127)"
    )


# ---------------------------------------------------------------------------
# 2. Cache-as-authoritative top-tier rule (#1149 / Current Shape Decision 4)
# ---------------------------------------------------------------------------


def test_cache_as_authoritative_section_present(agents_md_text: str) -> None:
    """The cache-as-authoritative rule must live in its own top-tier `##` section."""
    assert re.search(
        r"^##\s+Cache-as-authoritative work selection\s+\(#1149\)\s*$",
        agents_md_text,
        re.MULTILINE,
    ), "missing '## Cache-as-authoritative work selection (#1149)' header"


def test_cache_as_authoritative_must_rule_present(agents_md_text: str) -> None:
    """The MUST rule for `task triage:queue` must appear verbatim per Current Shape."""
    required = (
        'When the operator asks "what should I work on next?" / "build a cohort" / '
        '"what\'s the queue?", the agent MUST run `task triage:queue --limit=10`'
    )
    assert required in agents_md_text, (
        "missing top-tier ! rule for cache-as-authoritative work selection "
        "(verbatim per Current Shape Decision 4)"
    )
    assert (
        "(D11 / #1128)" in agents_md_text
    ), "cache-as-authoritative rule must cite D11 / #1128 (`task triage:queue`)"


def test_cache_as_authoritative_anti_pattern_present(agents_md_text: str) -> None:
    """The matching anti-pattern must forbid recommending without consulting the queue."""
    required = "Recommend a specific issue or vBRIEF without consulting `task triage:queue`"
    assert required in agents_md_text, (
        "missing top-tier \u2297 anti-pattern: must forbid recommending without "
        "consulting `task triage:queue` (or showing the operator the consultation result)"
    )


def test_cache_as_authoritative_uses_canonical_markers(agents_md_text: str) -> None:
    """The cache-as-authoritative section must use ! and \u2297 markers."""
    section = _extract_section(agents_md_text, r"Cache-as-authoritative work selection \(#1149\)")
    assert section, "Cache-as-authoritative section not isolatable"
    assert re.search(
        r"^!\s+When the operator asks", section, re.MULTILINE
    ), "Cache-as-authoritative MUST rule must use the canonical '! ' marker"
    assert re.search(
        r"^\u2297\s+Recommend", section, re.MULTILINE
    ), "Cache-as-authoritative anti-pattern must use the canonical '\u2297 ' marker"


# ---------------------------------------------------------------------------
# 3. Skill Routing entries (3 new + 2 amendments) (#1149)
# ---------------------------------------------------------------------------


def test_skill_routing_triage_hygiene_entry_present(agents_md_text: str) -> None:
    routing = _extract_section(agents_md_text, r"Skill Routing")
    assert routing, "Skill Routing section not isolatable"
    assert (
        '"triage hygiene"' in routing
        and '"work the cache"' in routing
        and "skills/deft-directive-triage/SKILL.md" in routing
    ), (
        "Skill Routing must include the 'triage hygiene' / 'work the cache' entry "
        "pointing at `skills/deft-directive-triage/SKILL.md`"
    )


def test_skill_routing_whats_next_entry_present(agents_md_text: str) -> None:
    routing = _extract_section(agents_md_text, r"Skill Routing")
    assert (
        '"what\'s next"' in routing
        and '"queue"' in routing
        and '"build a cohort"' in routing
        and "skills/deft-directive-triage/SKILL.md" in routing
    ), (
        "Skill Routing must include the 'what's next' / 'queue' / 'build a cohort' entry "
        "pointing at `skills/deft-directive-triage/SKILL.md`"
    )


def test_skill_routing_welcome_entry_present(agents_md_text: str) -> None:
    routing = _extract_section(agents_md_text, r"Skill Routing")
    assert (
        '"welcome"' in routing
        and '"onboard triage"' in routing
        and "task triage:welcome" in routing
        and "(N3 / #1143)" in routing
    ), (
        "Skill Routing must include the 'welcome' / 'onboard triage' entry "
        "invoking `task triage:welcome` (N3 / #1143)"
    )


def test_skill_routing_refinement_amendment_present(agents_md_text: str) -> None:
    """The refinement entry must be amended with the Phase 0 / N1 reference."""
    routing = _extract_section(agents_md_text, r"Skill Routing")
    assert "Phase 0 consults the triage cache first (see N1 / #1141)" in routing, (
        "Refinement routing entry must be amended with "
        "'Phase 0 consults the triage cache first (see N1 / #1141)'"
    )


def test_skill_routing_swarm_amendment_present(agents_md_text: str) -> None:
    """The swarm entry must be amended with the Phase 0 / N2 reference."""
    routing = _extract_section(agents_md_text, r"Skill Routing")
    assert "Phase 0 is queue-driven (see N2 / #1142)" in routing, (
        "Swarm routing entry must be amended with " "'Phase 0 is queue-driven (see N2 / #1142)'"
    )


# ---------------------------------------------------------------------------
# 4. Pre-`start_agent` gate stack order (#1149 / Current Shape Decision 5)
# ---------------------------------------------------------------------------


def test_pre_start_agent_gate_stack_paragraph_present(agents_md_text: str) -> None:
    """The Implementation Intent Gate section must include the gate-stack paragraph."""
    intent_gate = _extract_section(agents_md_text, r"Development Process \(always follow\)")
    assert intent_gate, "Development Process section not isolatable"
    assert "Pre-`start_agent` gate stack (#1149/#1348)" in intent_gate, (
        "Implementation Intent Gate section must include the "
        "'Pre-`start_agent` gate stack (#1149/#1348)' paragraph"
    )


def _extract_gate_stack_paragraph(agents_md_text: str) -> str:
    """Return the full Pre-`start_agent` gate-stack paragraph (until blank line / next heading)."""
    intent_gate = _extract_section(agents_md_text, r"Development Process \(always follow\)")
    # Paragraph terminator: blank line or next markdown heading. Use a tolerant
    # lookahead so the match grabs the entire prose paragraph including all
    # numbered gate references after the `Pre-`start_agent`` token in the heading.
    stack_match = re.search(
        r"\*\*Pre-`start_agent` gate stack \(#1149/#1348\):\*\*.*?(?=\r?\n\r?\n|^#{2,3}\s)",
        intent_gate,
        re.DOTALL | re.MULTILINE,
    )
    return stack_match.group(0) if stack_match else ""


def test_pre_start_agent_gate_stack_canonical_order(agents_md_text: str) -> None:
    # Gates must be named in canonical order through start_agent.
    stack = _extract_gate_stack_paragraph(agents_md_text)
    assert stack, (
        "Implementation Intent Gate section must include the pre-`start_agent` "
        "gate-stack paragraph (#1149)"
    )
    p_session = stack.find("session ritual gate")
    p_story = stack.find("story-start Gate 0")
    p_vbrief = stack.find("vBRIEF implementation-intent gate")
    p_cache = stack.find("task verify:cache-fresh")
    p_branch = stack.find("branch-policy gate")
    p_start = stack.rfind("start_agent")
    assert 0 <= p_session < p_story < p_vbrief < p_cache < p_branch < p_start, (
        "Pre-`start_agent` gate stack out of canonical order "
        f"(session={p_session}, story={p_story}, vbrief={p_vbrief}, "
        f"cache-fresh={p_cache}, branch={p_branch}, start_agent={p_start})"
    )


def test_pre_start_agent_gate_stack_cites_downstream_owners(
    agents_md_text: str,
) -> None:
    """The gate-stack paragraph must cite the issue owners of the constituent gates."""
    stack = _extract_gate_stack_paragraph(agents_md_text)
    assert stack, "gate-stack paragraph not isolatable"
    assert "#1348" in stack, "gate-stack paragraph must cite #1348 for the ritual gate"
    assert "#810" in stack, "gate-stack paragraph must cite #810 for the vBRIEF gate"
    assert "#1127" in stack, "gate-stack paragraph must cite D5 / #1127 for cache-fresh"
