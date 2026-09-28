/**
 * Presentation-ceiling artifact + compositor (#5056 schema / #5079).
 */

export {
  listCeilingArtifactTexts,
  type ParseArtifactResult,
  parseArtifactText,
  parsePresentationCeilingArtifact,
} from "./artifact.js";
export {
  compareRestrictions,
  type LoadArtifactsResult,
  type LoadedArtifact,
  loadArtifactsFromTexts,
} from "./compare.js";
export {
  type EvaluatePresentationCeilingOptions,
  evaluatePresentationCeiling,
} from "./evaluate.js";
export {
  isBuiltinPresentationExtension,
  isCeilingArtifactRel,
  isCssPath,
  isPresentationPath,
  normalizeExtensionToken,
  normalizeRel,
  pathExtension,
} from "./paths.js";
export {
  type AdmissionRuleId,
  BUILTIN_PRESENTATION_EXTENSIONS,
  CEILING_COMPOSITOR_GATE_ID,
  CEILING_COMPOSITOR_REMEDIATION,
  type ComposedGateCoverage,
  type PathAdmission,
  PRESENTATION_CEILING_DIR,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
  type PresentationCeilingArtifact,
  type PresentationCeilingEvaluateResult,
  type PresentationCeilingHumanApproval,
  type PresentationChangeClass,
  type RestrictionCompare,
  type RestrictionKind,
} from "./types.js";
