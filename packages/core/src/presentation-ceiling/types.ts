/**
 * Presentation-ceiling sibling gate (#5056).
 *
 * Under a recorded `changeClass: presentation` restriction, changed paths
 * outside the built-in presentation extension set refuse. Intent-constraint
 * N/A / no-new-facts is not ceiling evidence. In-class persistence stays on
 * leftover(#5056) #5059 / #5080.
 */

export const PRESENTATION_CEILING_SCHEMA = "deft.presentation-ceiling.v1" as const;
export const PRESENTATION_CEILING_PLAN_KEY = "x-directive/changeClass";
export const PRESENTATION_CEILING_ARTIFACT_REL = ".deft/presentation-ceiling.json";
export const PRESENTATION_CHANGE_CLASS = "presentation" as const;

export const GATE_ID = "verify:presentation-ceiling";

export const PRESENTATION_CEILING_REMEDIATION =
  "Remove or split paths outside the built-in presentation set, or land a " +
  "human-origin extension amendment on the merge-base ceiling artifact first. " +
  "Intent-constraint N/A or no-new-facts cannot be cited as ceiling evidence. " +
  "In-class persistence is leftover(#5056) #5059.";

export const EXTRA_CEREMONY_REMEDIATION =
  "Presentation-story ceremony on AGENTS.md, docs/, or .deft/core/ is fail-closed " +
  "extra ceremony (not P1). Split it or keep it off this presentation-ceiling PR.";

export const REMOVAL_REMEDIATION =
  "A ceiling-bound brief move, rename, or deletion is a removal event. The " +
  "authorizing stamp is read from the merge-base copy; a head stamp cannot " +
  "authorize. Same-PR mix of removal with product paths refuses.";

export const WEAKEN_REMEDIATION =
  "Weakening or removing a merge-base presentation ceiling refuses on this " +
  "sibling gate. Head stamps cannot authorize.";

/** Built-in presentation suffixes: isMarkupPath (.html/.jsx/.tsx) plus .css. */
export const BUILTIN_PRESENTATION_EXTS = [".html", ".jsx", ".tsx", ".css"] as const;

export const GATE_TOOLING_PREFIXES = [
  "packages/core/src/intent-constraint/",
  "packages/core/src/class-checks/",
  "packages/core/src/scope-provenance/",
  "packages/core/src/observable-scope/",
  "packages/core/src/test-boundary/",
  "packages/core/src/presentation-ceiling/",
  "packages/core/src/presentation-coverage/",
  "packages/cli/src/verify-presentation-ceiling.ts",
  "packages/cli/src/verify-presentation-coverage.ts",
] as const;

export const LOADER_NAMES = [
  "readApprovedScopeRecord",
  "loadRecord",
  "listApprovedScopeRecords",
] as const;

export type PresentationChangeClass = typeof PRESENTATION_CHANGE_CLASS;

export interface PresentationHumanApproval {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia?: string;
}

export interface PresentationExtensionAmendment {
  readonly extensions: readonly string[];
  readonly humanApproval: PresentationHumanApproval;
}

export interface PresentationCeilingArtifact {
  readonly schema: typeof PRESENTATION_CEILING_SCHEMA;
  readonly changeClass: PresentationChangeClass;
  readonly path: string;
  readonly allowedExtensions: readonly string[];
  /** Absent means unrestricted; an explicit empty list permits no built-in extensions. */
  readonly hasExtensionRestriction?: boolean;
  readonly componentRoots: readonly string[];
  readonly extensionAmendment: PresentationExtensionAmendment | null;
  readonly removalStamp: PresentationHumanApproval | null;
}

export type PresentationFindingKind =
  | "out-of-class-path"
  | "json-exemption-referenced"
  | "changelog-production-reader"
  | "dynamic-exempt-path"
  | "ceiling-removal"
  | "ceiling-weaken"
  | "extra-ceremony";

export interface PresentationCeilingFinding {
  readonly kind: PresentationFindingKind;
  readonly path: string;
  readonly detail: string;
  readonly remediation: string;
}

export interface PresentationCeilingResult {
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly PresentationCeilingFinding[];
  readonly message: string;
  readonly armed: boolean;
  readonly evaluatedPaths: readonly string[];
  readonly unevaluatedNote: string;
}

export interface PresentationCeilingSnapshot {
  readonly changedFiles: readonly string[];
  readonly baseArtifacts: readonly PresentationCeilingArtifact[];
  readonly headArtifacts: readonly PresentationCeilingArtifact[];
  readonly baseActiveXbriefPath: string | null;
  readonly baseActiveXbriefPaths?: readonly string[];
  readonly headFileContents: ReadonlyMap<string, string>;
  readonly standingFileContents: ReadonlyMap<string, string>;
  readonly baseFileContents?: ReadonlyMap<string, string>;
  readonly baseTestRoots: readonly string[];
  readonly baseFixtureRoots: readonly string[];
  readonly defaultTestRoots: readonly string[];
  readonly defaultFixtureRoots: readonly string[];
}
