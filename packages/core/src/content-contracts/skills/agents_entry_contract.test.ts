import { describe, expect, it } from "vitest";
import { EVAL_READBACK_SUPPRESSION_HOURS } from "../../eval/readback.js";
import { VALUE_READBACK_SUPPRESSION_HOURS } from "../../value/readback.js";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_agents_entry_contract.py (#768, #1309, #2111). */

const OPEN_MARKER = "<!-- deft:managed-section v3 -->";
const CLOSE_MARKER = "<!-- /deft:managed-section -->";

const PROPAGATION_COMMAND_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["deft session:start", "task session:start"],
  ["deft verify:session-ritual", "task verify:session-ritual"],
  ["deft verify:tools", "task verify:tools"],
  ["deft triage:welcome --onboard", "task triage:welcome --onboard"],
  ["deft triage:queue", "task triage:queue"],
  ["deft verify:cache-fresh", "task verify:cache-fresh"],
  ["deft codebase:map", "task codebase:map"],
  ["deft verify:codebase-map-fresh", "task verify:codebase-map-fresh"],
  ["deft verify:branch", "task verify:branch"],
  ["deft verify:forward-coverage", "task verify:forward-coverage"],
  ["deft verify:story-ready", "task verify:story-ready"],
  ["deft doctor", "task doctor"],
  ["deft agents:refresh", "task agents:refresh"],
  ["deft packs:slice --list-packs", "deft packs:slice --list-packs"],
  ["npm i -g @deftai/directive@latest", "npm i -g @deftai/directive@latest"],
  ["git status --short --branch", "git status --short --branch"],
  ["deft scope:promote -- <path>", "task scope:promote -- <path>"],
  ["deft scope:activate -- <path>", "task scope:activate -- <path>"],
  ["deft scope:complete -- <active-story-path>", "task scope:complete -- <active-story-path>"],
  ["deft umbrella:current-shape", "task umbrella:current-shape"],
  ["deft xbrief:preflight", "task xbrief:preflight"],
  ["deft policy:enable-value-feedback", "task policy:enable-value-feedback"],
  ["deft policy:show --field=valueFeedback", "task policy:show --field=valueFeedback"],
  ["deft value:show", "task value:show"],
  ["deft eval:health", "task eval:health"],
  ["deft eval:run", "task eval:run"],
  ["deft eval:report", "task eval:report"],
  ["deft feedback:file", "task feedback:file"],
  ["deft migrate:xbrief", "deft migrate:xbrief"],
  ["xbrief/PROJECT-DEFINITION.xbrief.json", "xbrief/PROJECT-DEFINITION.xbrief.json"],
  ["xbrief/active/", "xbrief/active/"],
];

const CONSUMER_FORBIDDEN_BARE_TASK_MARKERS = [
  "task session:start",
  "task verify:session-ritual",
  "task verify:tools",
  "task doctor",
  "task agents:refresh",
  "task triage:welcome",
  "task triage:queue",
  "task verify:cache-fresh",
  "task codebase:map",
  "task verify:codebase-map-fresh",
  "task verify:branch",
  "task verify:forward-coverage",
  "task verify:story-ready",
  "task policy:show",
  "task policy:enforce-branches",
  "task policy:allow-direct-commits",
  "task policy:enable-value-feedback",
  "task value:show",
  "task feedback:file",
  "task scope:promote",
  "task scope:activate",
  "task scope:complete",
  "task scope:demote",
  "task xbrief:preflight",
  "task xbrief:activate",
  "task framework:doctor",
  "task check",
  "task setup",
  "task verify:hooks-installed",
] as const;

const PROPAGATION_POLICY_KEY_MARKERS = [
  "plan.policy.wipCap",
  "plan.policy.allowDirectCommitsToMaster",
  "plan.policy.sessionRitualStalenessHours",
  "plan.policy.valueFeedback",
] as const;

const PROPAGATION_HEADER_MARKERS = [
  "## Session-start ritual (#1149)",
  "## Unmanaged project header (#2065)",
  "## Cache-as-authoritative work selection (#1149)",
  "## Deterministic questions runtime obligation (#1470)",
  "## Skills",
  "## WIP cap",
  "## Codebase MAP Projection (#1595 / #1498)",
  "### Story Start Gate",
  "## Platform-conditional rules (PowerShell / Windows)",
  "## Content packs",
] as const;

const PROPAGATION_ACTION_VERBS = [
  "build",
  "implement",
  "ship",
  "swarm",
  "run agents",
  "start agent",
] as const;

// #838: skill routing moved from the AGENTS.md `## Skill Routing` table to the
// REFERENCES.md Skills Index. AGENTS.md keeps only a `## Skills` pointer.
const SKILLS_POINTER_MARKERS = ["## Skills", "Skills Index", "REFERENCES.md"] as const;

// Every non-deprecated skill catalogued under content/skills/ that the
// REFERENCES.md Skills Index MUST list (name + description + triggers).
const INDEXED_SKILL_IDS = [
  "deft-directive-setup",
  "deft-directive-cost",
  "deft-directive-build",
  "deft-directive-pre-pr",
  "deft-directive-review-cycle",
  "deft-directive-swarm",
  "deft-directive-decompose",
  "deft-directive-refinement",
  "deft-directive-triage",
  "deft-directive-sync",
  "deft-directive-interview",
  "deft-directive-probe",
  "deft-directive-debug",
  "deft-directive-glossary",
  "deft-directive-gh-arch",
  "deft-directive-gh-slice",
  "deft-directive-release",
  "deft-directive-write-skill",
  "deft-directive-article-review",
  "deft-directive-feedback",
] as const;

const PROPAGATION_UMBRELLA_STATUS_MARKERS = [
  "claim-cites-state-surface",
  "issues/<N>/comments",
  "Conclude umbrella or epic status from the issue body alone",
] as const;

const UNMANAGED_HEADER_MARKERS = [
  "Do NOT treat the unmanaged AGENTS.md header as the work queue",
  "Do NOT add `Status`, `Next:`, or `Known Issues` blocks",
  "Session orientation",
] as const;

type PointerRequirement =
  | {
      kind: "doc";
      consumerMarker: string;
      maintainerMarker: string;
      targetPath: string;
      targetMarkers: readonly string[];
    }
  | {
      kind: "gate";
      consumerCommand: string;
      maintainerCommand: string;
    }
  | {
      kind: "skill";
      skillId: string;
      skillPath: string;
      consumerMarkers?: readonly string[];
      maintainerMarkers?: readonly string[];
      frontmatterMarkers?: readonly string[];
    };

type PointerContract = {
  id: string;
  heading: string;
  requirements: readonly PointerRequirement[];
};

// #2371: bulky rule propagation is pointer-sufficient. These entries no longer
// assert that every rule-body marker is mirrored into AGENTS.md and the consumer
// template; they assert that each relocated rule has a typed, resolvable pointer.
const POINTER_SUFFICIENT_RULE_CONTRACTS: readonly PointerContract[] = [
  {
    id: "review-surface-precedence",
    heading: "## Review-surface precedence (#2308)",
    requirements: [
      {
        kind: "skill",
        skillId: "deft-directive-review-cycle",
        skillPath: "skills/deft-directive-review-cycle/SKILL.md",
      },
    ],
  },
  {
    id: "value-feedback",
    heading: "## Value feedback and attribution (#1709)",
    requirements: [
      {
        kind: "gate",
        consumerCommand: "deft policy:show --field=valueFeedback",
        maintainerCommand: "task policy:show --field=valueFeedback",
      },
      {
        kind: "gate",
        consumerCommand: "deft feedback:file",
        maintainerCommand: "task feedback:file",
      },
      {
        kind: "skill",
        skillId: "deft-directive-feedback",
        skillPath: "skills/deft-directive-feedback/SKILL.md",
      },
    ],
  },
  {
    id: "eval-framework-health",
    heading: "## Eval and framework health (#1703)",
    requirements: [
      {
        kind: "doc",
        consumerMarker: "AGENTS.md and `deft triage:help` are canonical",
        maintainerMarker: "AGENTS.md and `task triage:help` are canonical",
        targetPath: "templates/agents-entry.md",
        targetMarkers: [
          "crud-metrics.jsonl",
          "health-history.jsonl",
          "contradictory gate",
          "4-hour debounce",
          "Tier 1",
          "Tier 2",
        ],
      },
      {
        kind: "gate",
        consumerCommand: "deft eval:health",
        maintainerCommand: "task eval:health",
      },
      {
        kind: "gate",
        consumerCommand: "deft eval:run",
        maintainerCommand: "task eval:run",
      },
      {
        kind: "gate",
        consumerCommand: "deft eval:report",
        maintainerCommand: "task eval:report",
      },
    ],
  },
  {
    id: "deterministic-questions",
    heading: "## Deterministic questions runtime obligation (#1470)",
    requirements: [
      {
        kind: "doc",
        consumerMarker: ".deft/core/content/contracts/deterministic-questions.md",
        maintainerMarker: "content/contracts/deterministic-questions.md",
        targetPath: "contracts/deterministic-questions.md",
        targetMarkers: ["Discuss", "Back", "Discuss-pause semantic"],
      },
    ],
  },
] as const;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\s+/)
    .join(" ");
}

function missingMarkers(haystack: string, markers: readonly string[]): string[] {
  const normalized = normalizeWhitespace(haystack);
  return markers.filter((m) => !normalized.includes(normalizeWhitespace(m)));
}

function managedSection(text: string): string {
  const start = text.indexOf(OPEN_MARKER);
  const end = text.indexOf(CLOSE_MARKER);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + CLOSE_MARKER.length);
}

function sectionForHeading(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `heading not found: ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const nextHeading = rest.slice(heading.length).search(/\n## /);
  return nextHeading === -1 ? rest : rest.slice(0, heading.length + nextHeading);
}

function skillFrontmatter(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function expectPointerRequirement(
  requirement: PointerRequirement,
  consumerSection: string,
  maintainerSection: string,
): void {
  if (requirement.kind === "doc") {
    expect(missingMarkers(consumerSection, [requirement.consumerMarker])).toEqual([]);
    expect(missingMarkers(maintainerSection, [requirement.maintainerMarker])).toEqual([]);
    expect(missingMarkers(readRepoFile(requirement.targetPath), requirement.targetMarkers)).toEqual(
      [],
    );
    return;
  }
  if (requirement.kind === "gate") {
    expect(missingMarkers(consumerSection, [requirement.consumerCommand])).toEqual([]);
    expect(missingMarkers(maintainerSection, [requirement.maintainerCommand])).toEqual([]);
    return;
  }
  const consumerMarkers = requirement.consumerMarkers ?? [requirement.skillId];
  const maintainerMarkers = requirement.maintainerMarkers ?? [requirement.skillId];
  expect(missingMarkers(consumerSection, consumerMarkers)).toEqual([]);
  expect(missingMarkers(maintainerSection, maintainerMarkers)).toEqual([]);

  const frontmatter = skillFrontmatter(readRepoFile(requirement.skillPath));
  expect(
    missingMarkers(frontmatter, [
      `name: ${requirement.skillId}`,
      "description:",
      ...(requirement.frontmatterMarkers ?? []),
    ]),
  ).toEqual([]);
}

describe("test_agents_entry_contract", () => {
  const template = readRepoFile("templates/agents-entry.md");
  const agents = readRepoFile("AGENTS.md");

  it("template_carries_managed_section_markers", () => {
    expect(template).toContain(OPEN_MARKER);
    expect(template).toContain(CLOSE_MARKER);
    expect(template.indexOf(OPEN_MARKER)).toBeLessThan(template.indexOf(CLOSE_MARKER));
  });

  it("managed_section_contains_implementation_intent_gate", () => {
    expect(managedSection(template)).toContain("Implementation Intent Gate");
  });

  it("propagation_command_markers_present_in_both_files", () => {
    const templateMissing = missingMarkers(
      template,
      PROPAGATION_COMMAND_MARKERS.map(([consumer]) => consumer),
    );
    const agentsMissing = missingMarkers(
      agents,
      PROPAGATION_COMMAND_MARKERS.map(([, maintainer]) => maintainer),
    );
    expect(templateMissing).toEqual([]);
    expect(agentsMissing).toEqual([]);
  });

  it("consumer_template_does_not_use_unresolved_bare_task_names", () => {
    const leaked = CONSUMER_FORBIDDEN_BARE_TASK_MARKERS.filter((m) => template.includes(m));
    expect(leaked).toEqual([]);
  });

  it("propagation_policy_key_markers_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_POLICY_KEY_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_POLICY_KEY_MARKERS)).toEqual([]);
  });

  it("propagation_header_markers_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_HEADER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_HEADER_MARKERS)).toEqual([]);
  });

  it("propagation_action_verb_list_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_ACTION_VERBS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_ACTION_VERBS)).toEqual([]);
  });

  it("skill_routing_table_removed_from_policy_files", () => {
    // #838: the keyword->path routing table moved to the REFERENCES.md Skills Index.
    expect(agents).not.toContain("## Skill Routing");
    expect(template).not.toContain("## Skill Routing");
  });

  it("skills_pointer_present_in_both_files", () => {
    expect(missingMarkers(template, SKILLS_POINTER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, SKILLS_POINTER_MARKERS)).toEqual([]);
  });

  it("references_md_indexes_every_skill", () => {
    const references = readRepoFile("REFERENCES.md");
    expect(references).toContain("Skills Index");
    expect(missingMarkers(references, INDEXED_SKILL_IDS)).toEqual([]);
  });

  it("propagation_umbrella_status_markers_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_UMBRELLA_STATUS_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_UMBRELLA_STATUS_MARKERS)).toEqual([]);
  });

  it("unmanaged_header_contract_markers_present_in_both_files", () => {
    expect(missingMarkers(template, UNMANAGED_HEADER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, UNMANAGED_HEADER_MARKERS)).toEqual([]);
  });

  it.each(
    POINTER_SUFFICIENT_RULE_CONTRACTS.map((contract) => [contract.id, contract] as const),
  )("propagation pointer contract resolves %s", (_id, contract) => {
    const consumerSection = sectionForHeading(template, contract.heading);
    const maintainerSection = sectionForHeading(agents, contract.heading);
    for (const requirement of contract.requirements) {
      expectPointerRequirement(requirement, consumerSection, maintainerSection);
    }
  });

  it("propagation_pointer_contracts_cover_all_pointer_kinds", () => {
    const kinds = new Set<PointerRequirement["kind"]>();
    for (const contract of POINTER_SUFFICIENT_RULE_CONTRACTS) {
      for (const requirement of contract.requirements) {
        kinds.add(requirement.kind);
      }
    }
    expect(kinds).toEqual(new Set(["doc", "gate", "skill"]));
  });

  it("value_readback_suppression_window_is_four_hours", () => {
    expect(VALUE_READBACK_SUPPRESSION_HOURS).toBe(4);
  });

  it("eval_readback_suppression_window_is_four_hours", () => {
    expect(EVAL_READBACK_SUPPRESSION_HOURS).toBe(4);
  });

  it("content_packs_note_references_discovery_commands", () => {
    const section = managedSection(template);
    expect(section).toContain("--list-packs");
    expect(section).toContain("<pack> --list");
  });
});
