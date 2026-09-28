/** #5079 composes gate evidence; #5056 owns the presentation class boundary. */
export const CEILING_COMPOSITOR_GATE_ID = "verify:presentation-coverage";
export const PRESENTATION_CEILING_ARTIFACT_REL = ".deft/presentation-ceiling.json";
export const PRESENTATION_CEILING_SCHEMA = "deft.presentation-ceiling.v1";
export const PRESENTATION_CEILING_PLAN_KEY = "x-directive/changeClass";
export const BUILTIN_PRESENTATION_EXTENSIONS = [".html", ".jsx", ".tsx", ".css"] as const;
export const CEILING_COMPOSITOR_REMEDIATION =
  "Restore the restriction or obtain merge-base human authority for the same story and paths. " +
  "Required failures and unknown coverage cannot authorize continuation; unattended parks.";
export interface PresentationCeilingArtifact {
  readonly hasExtensionRestriction: boolean;
  readonly allowedExtensions: readonly string[];
  readonly componentRoots: readonly string[];
  readonly extensionAmendment: {
    readonly extensions: readonly string[];
    readonly humanApproval: unknown;
  } | null;
  readonly removalStamp: unknown;
}
export interface LoadedArtifact {
  readonly rel: string;
  readonly artifact: PresentationCeilingArtifact;
}
export interface RestrictionCompare {
  readonly kind:
    | "off-ceiling"
    | "add-only"
    | "tightening"
    | "unchanged-base"
    | "weakening"
    | "removal";
  readonly armed: boolean;
  readonly refuseWeakenOrRemove: boolean;
  readonly artifactRels: readonly string[];
}
export interface PathAdmission {
  readonly path: string;
  readonly ruleId:
    | "intent-constraint-mint"
    | "observable-scope-mint"
    | "presentation-extension-amendment";
  readonly authority: string;
  /** Base extension authority required before a nonbuiltin intent path is in class. */
  readonly prerequisiteAuthority?: string;
  readonly planId?: string;
}
export interface ComposedGateCoverage {
  readonly gateId: string;
  readonly status: "evaluated" | "skipped" | "unrun";
  readonly code: 0 | 1 | 2 | null;
  readonly analyzedPaths: readonly string[];
  readonly cannotEvaluatePaths: readonly string[];
  readonly message: string;
}
export interface PresentationCoverageEvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly skipped: boolean;
  readonly armed: boolean;
  readonly compare: RestrictionCompare;
  readonly uncoveredPaths: readonly string[];
  readonly coverage: readonly ComposedGateCoverage[];
  readonly admissions: readonly PathAdmission[];
}
