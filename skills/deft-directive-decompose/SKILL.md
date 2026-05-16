---
name: deft-directive-decompose
description: >
  Convert approved specification/phase/epic scope vBRIEFs into swarm-ready
  story vBRIEFs before concurrent agent allocation.
---

# Deft Directive Decompose

Use this skill when a specification, Phase 4 implementation scope, or epic vBRIEF is too broad for direct concurrent swarm work and must be decomposed into story-level vBRIEFs.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [strategies/speckit.md](../../strategies/speckit.md) Phase 4.5 | [vbrief/vbrief.md](../../vbrief/vbrief.md) Swarm-Ready Story Contract | [deft-directive-swarm](../deft-directive-swarm/SKILL.md)

## Purpose

Convert approved specification/phase/epic scope vBRIEFs into swarm-ready child story vBRIEFs. Story vBRIEFs are the only valid input for concurrent swarm worker allocation.

## Phase 0: Inspect

- ! Read `vbrief/specification.vbrief.json` and relevant scope vBRIEFs from `vbrief/proposed/`, `vbrief/pending/`, and `vbrief/active/`
- ! Identify broad scopes with `plan.metadata.kind = "phase"` or `"epic"` or scopes with broad `plan.narratives.Acceptance` and empty `plan.items`
- ! Preserve parent acceptance as context; do not treat it as executable story acceptance
- ! Treat parent `plan.items` as input signals only; they are not automatically child stories
- ! Inspect relevant codebase paths before drafting file scope so stories reflect real product/code boundaries, not only parent scope prose
- ! Identify requirement traces, likely file scope, verification commands, outputs/evidence, dependencies, and conflict groups
- ⊗ Allocate a broad phase/epic scope to concurrent workers during this skill

## Phase 1: Draft

- ! Draft a decomposition JSON proposal with child stories only; do not write child vBRIEFs yet
- ! Each story MUST include `id`, `title`, `Description`, `ImplementationPlan`, `UserStory`, executable `items` or `acceptance`, `traces` or explicit trace justification, `swarm.file_scope`, `swarm.verify_commands`, `swarm.expected_outputs`, `swarm.depends_on`, `swarm.conflict_group`, `swarm.size`, `swarm.file_scope_confidence`, and `swarm.model_tier`.
- ! `Description` MUST provide at least two concrete sentences explaining the user/product behavior, boundaries, and why this story is independently buildable
- ! `ImplementationPlan` MUST provide at least two concrete implementation steps that identify the expected code path, state/data changes, and test/evidence approach
- ! `UserStory` MUST use the exact product-story shape `As a <role>, I want <capability>, so that <outcome>.`
- ! Each ready story MUST have 2-5 concrete acceptance criteria unless `swarm.acceptance_criteria_justification` explains the exception
- ! Acceptance criteria MUST be observable behavior, preferably Given/When/Then or equivalent testable product behavior
- ⊗ Mark a story ready when acceptance says only "to refine from parent scope", duplicates the title/description, is placeholder text, or is vague docs-only acceptance
- ⊗ Mark a story ready with broad write scope such as `backend/**`, `frontend/**`, `docs/**`, `vbrief/**`, or any other directory glob
- ⊗ Mark a story ready when verification is only generic validation such as `task check`
- ⊗ Mark a story ready with `parallel_safe: false` or `file_scope_confidence: low`; use `readiness: sequential` or `readiness: needs_refinement` instead
- ! Model dependencies as story IDs and ensure they form a DAG
- ~ Draft sequential-safe or low-confidence work as `readiness: sequential` or `readiness: needs_refinement`; it is not eligible for concurrent allocation
- ⊗ Use deprecated `subItems` in newly drafted story items; use `items`

## Phase 2: Approval

- ! Present the decomposition draft to the user before writing files
- ! Ask for explicit approval to apply the draft
- ! If the user requests changes, revise the draft and re-present it
- ? Run `task scope:decompose ... --check` before explicit approval only to validate a draft without writing files.
- ⊗ Apply `task scope:decompose` without `--check` before explicit approval.

## Phase 3: Apply

- ! Validate the approved draft first:

```bash
task scope:decompose -- <parent.vbrief.json> --draft <decomposition.json> --check
```

- ! Apply the approved draft:

```bash
task scope:decompose -- <parent.vbrief.json> --draft <decomposition.json>
```

The command creates child story vBRIEFs, preserves origin/provenance references, sets each child `planRef` to the parent, updates parent references to include the children, rejects dependency cycles, and rejects ready stories missing executable acceptance, user-story shape, concrete acceptance, narrow file scope, focused verify commands, or traces.

## Phase 4: Readiness

- ! Run readiness after decomposition:

```bash
task swarm:readiness -- vbrief/active/*.vbrief.json
```

- ~ If child stories are still pending, run readiness against their explicit paths for a dry readiness review before activation
- ! Route blocked or overlapping stories back to Phase 1 for draft refinement
- ! Leave lifecycle promotion/activation to the existing approved flow (`task scope:promote`, `task scope:activate`, and the swarm skill lifecycle bridge).
- ⊗ Promote or activate child stories solely because decomposition succeeded.

## Exit

deft-directive-decompose complete -- exiting skill. Next, activate the approved child story vBRIEFs through the existing lifecycle flow, then run `skills/deft-directive-swarm/SKILL.md` for concurrent allocation.
