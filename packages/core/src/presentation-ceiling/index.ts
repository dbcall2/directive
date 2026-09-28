/**
 * Presentation-ceiling sibling gate (#5056).
 */

export {
  effectivePresentationExts,
  evaluatePresentationCeiling,
  evaluatePresentationCeilingFromSnapshot,
  isApprovedScopeRecordPath,
  isBuiltinPresentationPath,
  isCssPath,
  isExtraCeremonyPath,
  isGateToolingPath,
  normalizeRepoRelPath,
  type PresentationCeilingOptions,
  parseCeilingPayload,
  pathExtension,
  resolvePresentationCeilingBaseRef,
} from "./evaluate.js";
export {
  BUILTIN_PRESENTATION_EXTS,
  EXTRA_CEREMONY_REMEDIATION,
  GATE_ID,
  GATE_TOOLING_PREFIXES,
  LOADER_NAMES,
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_PLAN_KEY,
  PRESENTATION_CEILING_REMEDIATION,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
  type PresentationCeilingArtifact,
  type PresentationCeilingFinding,
  type PresentationCeilingResult,
  type PresentationCeilingSnapshot,
  type PresentationChangeClass,
  type PresentationExtensionAmendment,
  type PresentationFindingKind,
  type PresentationHumanApproval,
  REMOVAL_REMEDIATION,
  WEAKEN_REMEDIATION,
} from "./types.js";
