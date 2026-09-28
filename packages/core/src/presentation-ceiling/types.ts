/**
 * Presentation-ceiling artifact schema (#5056) and compositor types (#5079).
 *
 * One store: `.deft/presentation-ceilings/*.json`. #5079 consumes this schema
 * and the base-versus-head restriction compare; it does not mint a second store.
 * If #5056 has not landed, this module owns that compare until the sibling lands.
 */

export const PRESENTATION_CEILING_DIR = ".deft/presentation-ceilings";
export const PRESENTATION_CEILING_SCHEMA = "deft.presentation-ceiling.v1" as const;
export const PRESENTATION_CHANGE_CLASS = "presentation" as const;
export const CEILING_COMPOSITOR_GATE_ID = "verify:presentation-ceiling";

/** Built-in presentation extensions: isMarkupPath plus `.css` (#5056 / #5079 item 9). */
export const BUILTIN_PRESENTATION_EXTENSIONS = [".html", ".jsx", ".tsx", ".css"] as const;

export const CEILING_COMPOSITOR_REMEDIATION =
  "Under an armed presentation ceiling, cannot-evaluate is refuse or escalate. " +
  "Continue only from a merge-base human-stamped mint or extraExtensions amendment " +
  "that covers the same paths. A head restriction arms but never admits. Unattended parks.";

export type PresentationChangeClass = typeof PRESENTATION_CHANGE_CLASS;

export interface PresentationCeilingHumanApproval {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia?: string;
}

export interface PresentationCeilingArtifact {
  readonly schema: typeof PRESENTATION_CEILING_SCHEMA;
  readonly changeClass: PresentationChangeClass;
  readonly allowlist: readonly string[];
  readonly extraExtensions: readonly string[];
  readonly humanApproval?: PresentationCeilingHumanApproval;
}

export type RestrictionKind =
  | "off-ceiling"
  | "add-only"
  | "tightening"
  | "unchanged-base"
  | "weakening"
  | "removal";

export interface RestrictionCompare {
  readonly kind: RestrictionKind;
  readonly armed: boolean;
  readonly refuseWeakenOrRemove: boolean;
  readonly artifactRels: readonly string[];
}

export type AdmissionRuleId =
  | "intent-constraint-mint"
  | "observable-scope-mint"
  | "presentation-extension-amendment";

export interface PathAdmission {
  readonly path: string;
  readonly ruleId: AdmissionRuleId;
}

export interface ComposedGateCoverage {
  readonly gateId: string;
  readonly skipped: boolean;
  readonly analyzedPaths: readonly string[];
  readonly cannotEvaluatePaths: readonly string[];
  readonly code: 0 | 1 | 2;
}

export type OutputStream = "stdout" | "stderr" | "none";

export interface PresentationCeilingEvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
  readonly armed: boolean;
  readonly compare: RestrictionCompare;
  readonly uncoveredPaths: readonly string[];
  readonly coverage: readonly ComposedGateCoverage[];
}
