/**
 * C3 live-procedure exclusion declaration (#3602 / #3899).
 *
 * History, examples, and prohibitions are skipped by this list, not by
 * matching prose patterns. A file that names a deleted Python script in
 * order to forbid treating it as a live path must appear here as
 * `prohibition` or C3 will mis-fire.
 */

export type LiveProcedureExclusionKind = "history" | "example" | "prohibition";

export interface LiveProcedureExclusion {
  /** POSIX path relative to a flattened consumer deposit root. */
  readonly path: string;
  readonly kind: LiveProcedureExclusionKind;
  readonly reason: string;
  /**
   * Heading title with no leading hashes. When set, only that heading range is
   * skipped (until the next heading of the same or higher level). Omit for a
   * whole-file skip. #4100: UPGRADING frozen hops are section-level, not a
   * `history/archive/` tree skip.
   */
  readonly section?: string;
}

export const LIVE_PROCEDURE_EXCLUSIONS: readonly LiveProcedureExclusion[] = [
  {
    path: "scm/github.md",
    kind: "prohibition",
    reason:
      "Names deleted Python scripts to forbid treating them as live implementation paths (#2022).",
  },
  {
    path: "UPGRADING.md",
    section: "From v0.70.x → v0.71.0 (triage cache relocation, #1703)",
    kind: "history",
    reason: "Pinned pre-Python-free version hop; not the current upgrade path (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From v0.60.0 → v0.61.x (refresh project-root git hooks, #2049)",
    kind: "history",
    reason: "Names deleted Python hook scripts on a pinned hop (#4100 section skip).",
  },
  {
    path: "UPGRADING.md",
    section: "Canonical installer + doctor handoff (v0.37+ / Epic-5+6 #1339 #1340, #1409)",
    kind: "history",
    reason: "Frozen Go-installer doctor.py handoff; current path is npm (#4100).",
  },
  {
    path: "UPGRADING.md",
    section:
      "From v0.53.0–v0.53.1 → v0.53.2 (vitest no longer discovers vendored framework tests, #1878)",
    kind: "history",
    reason: "Pinned vitest-discovery hop; not current recovery (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From v0.27.x -> v0.28 (canonical install manifest at `<install>/VERSION`)",
    kind: "history",
    reason: "Names retired framework_doctor.py on a pinned hop (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From drifted AGENTS.md -> current install (`task upgrade` repair path, #1061)",
    kind: "history",
    reason: "Names retired doctor.py / prose tests on a pinned hop (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From deft/ -> .deft/core/",
    kind: "history",
    reason: "Names retired relocate.py helpers on a pinned hop (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From v0.26.x -> v0.27 (triage adoption via `task triage:welcome`)",
    kind: "history",
    reason: "Names retired triage_welcome.py / policy.py on a pinned hop (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From v0.25.x → v0.26.0 (deft-cache unified layer; breaking)",
    kind: "history",
    reason: "Pinned cache-layout hop; not the current upgrade path (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "Migration to triage v1",
    kind: "history",
    reason: "Additive v0.24 triage opt-in history; not current recovery (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From pre-#768 AGENTS.md → managed-section AGENTS.md",
    kind: "history",
    reason: "Pinned managed-section hop; not the current upgrade path (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "From any pre-v0.20 version → v0.20.0 (historical; use frozen path)",
    kind: "history",
    reason: "Historical v0.20 cutover list; hop 1 stays on the frozen subsection (#4100).",
  },
  {
    path: "UPGRADING.md",
    section: "Frozen pre-v0.20 document-model migration (#2068)",
    kind: "history",
    reason:
      "Names scripts/migrate_vbrief.py as hop-1 history; current hop 2 is migrate:xbrief (#4100).",
  },
  {
    path: "deployments/aws/via-elastic-beanstalk.md",
    kind: "example",
    reason: "Consumer AWS sample `scripts/create_admin.py` is not a deposit helper.",
  },
  {
    path: "conventions/machine-generated-banner.md",
    kind: "history",
    reason:
      "Registry of historical Python writers that produced the banner; not a live consumer procedure.",
  },
  {
    path: "docs/BROWNFIELD.md",
    kind: "history",
    reason: "Brownfield migration history of the Python migrator on pinned releases.",
  },
  {
    path: "languages/python.md",
    kind: "example",
    reason: "Python language pack names consumer application files, not deposit helpers.",
  },
  {
    path: "languages/kotlin.md",
    kind: "example",
    reason: "Kotlin stdlib `run` scoping function is not the deposit Python launcher.",
  },
  {
    path: "deployments/aws/via-lambda.md",
    kind: "example",
    reason: "AWS Lambda sample `src/app.py` is a consumer application, not a deposit helper.",
  },
  {
    path: "deployments/fly-io/via-dockerfile.md",
    kind: "example",
    reason: "Fly.io sample `app.py` / `manage.py` are consumer application files.",
  },
  {
    path: "coding/toolchain.md",
    kind: "example",
    reason: "Cites framework test paths that pin the toolchain contract; not a live helper.",
  },
  {
    path: "coding/testing.md",
    kind: "example",
    reason: "Documents `_test.py` naming for consumer Python tests, not a deposit helper.",
  },
  {
    path: "contracts/deterministic-questions.md",
    kind: "example",
    reason: "Cites the contract's own test path; not a live consumer helper.",
  },
  {
    path: "conventions/task-caching.md",
    kind: "example",
    reason: "Cites framework tests that pin task-caching; not a live helper.",
  },
  {
    path: "events/README.md",
    kind: "history",
    reason: "Maintainer event-registry history naming retired Python writers and their tests.",
  },
  {
    path: "templates/agents-entry.placeholders.md",
    kind: "example",
    reason: "Cites the agents-entry contract test; not a live helper.",
  },
  {
    path: "templates/swarm-greptile-poller-prompt.md",
    kind: "example",
    reason: "Cites the poller-template contract test; not a live helper.",
  },
  {
    path: "verification/plan-checking.md",
    kind: "example",
    reason: "Swarm-spec example names `tests/test_auth.py` as consumer test layout.",
  },
  {
    path: "swarm/swarm.md",
    kind: "example",
    reason: "Swarm-spec example names `src/auth.py` / `tests/test_auth.py` as consumer files.",
  },
  {
    path: "skills/deft-directive-setup/SKILL.md",
    kind: "example",
    reason: "Setup skill Python example names `src/ui.py` as a consumer application file.",
  },
];

const WHOLE_FILE_EXCLUSION_PATHS = new Set(
  LIVE_PROCEDURE_EXCLUSIONS.filter((entry) => entry.section === undefined).map(
    (entry) => entry.path,
  ),
);

export function isDeclaredLiveProcedureExclusion(relativePath: string): boolean {
  return WHOLE_FILE_EXCLUSION_PATHS.has(relativePath.replace(/\\/g, "/"));
}

export function parseMarkdownHeading(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1]?.length ?? 0, title: match[2] ?? "" };
}

export function isLiveProcedureSectionExcluded(relativePath: string, title: string): boolean {
  const posix = relativePath.replace(/\\/g, "/");
  return LIVE_PROCEDURE_EXCLUSIONS.some((entry) => entry.path === posix && entry.section === title);
}
