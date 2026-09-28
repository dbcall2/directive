/** #5079 policy anchor: base authority admits; head restrictions only arm/tighten.
 * Every required evaluator runs before continuation. A pass from a narrow
 * scanner is not general authorization. Missing results and unreadable snapshot
 * material fail closed. No changes to #4541's fact kinds or supported languages.
 */
import { resolve } from "node:path";
import { evaluateIntentConstraint } from "../intent-constraint/evaluate.js";
import { isProductionSourcePath } from "../intent-constraint/extract.js";
import { evaluateObservableScope } from "../observable-scope/evaluate.js";
import { isMarkupPath } from "../observable-scope/extract.js";
import { matchPolicyGlob } from "../test-boundary/evaluate.js";
import { type CurrentStory, currentStory, scopedMint, storyCovers } from "./admission.js";
import { loadArtifactsFromTexts } from "./artifact.js";
import { compareRestrictions, effectiveExtensions } from "./compare.js";
import { COMPOSED_GATE_IDS, runComposedGates } from "./gates.js";
import { isCeilingArtifactRel, pathExtension } from "./paths.js";
import { type CoverageSnapshot, loadSnapshot, readTexts } from "./snapshot.js";
import {
  BUILTIN_PRESENTATION_EXTENSIONS,
  CEILING_COMPOSITOR_GATE_ID,
  CEILING_COMPOSITOR_REMEDIATION,
  type ComposedGateCoverage,
  type LoadedArtifact,
  type PathAdmission,
  type PresentationCoverageEvaluateResult,
  type RestrictionCompare,
} from "./types.js";
export interface EvaluatePresentationCoverageOptions {
  readonly projectRoot?: string;
  readonly originRef?: string;
  readonly staged?: boolean;
  readonly quiet?: boolean;
  readonly planId?: string;
  /** In-process test seam only; CLI never accepts worker-provided outcomes. */
  readonly snapshot?: CoverageSnapshot;
  readonly gateRunner?: (
    snapshot: CoverageSnapshot,
    planId?: string,
  ) => readonly ComposedGateCoverage[];
}
const OFF: RestrictionCompare = {
  kind: "off-ceiling",
  armed: false,
  refuseWeakenOrRemove: false,
  artifactRels: [],
};
function result(
  code: 0 | 1 | 2,
  message: string,
  compare: RestrictionCompare,
  coverage: readonly ComposedGateCoverage[] = [],
  uncoveredPaths: readonly string[] = [],
  admissions: readonly PathAdmission[] = [],
): PresentationCoverageEvaluateResult {
  return {
    code,
    message: `${CEILING_COMPOSITOR_GATE_ID}: ${message}${
      code === 0
        ? ""
        : code === 2
          ? " Repair the reported snapshot or required-gate configuration and rerun; unknown coverage cannot authorize continuation."
          : ` ${CEILING_COMPOSITOR_REMEDIATION}`
    }`,
    stream: code === 0 ? "stdout" : "stderr",
    skipped: !compare.armed,
    armed: compare.armed,
    compare,
    coverage,
    uncoveredPaths,
    admissions,
  };
}
function withinRestriction(path: string, art: LoadedArtifact): boolean {
  const roots = art.artifact.componentRoots;
  return (
    effectiveExtensions(art.artifact).includes(pathExtension(path)) &&
    (roots.length === 0 ||
      roots.some((r) => matchPolicyGlob(path, r) || path.startsWith(`${r.replace(/\/$/, "")}/`)))
  );
}
function admit(
  snapshot: CoverageSnapshot,
  path: string,
  story: CurrentStory,
  base: readonly LoadedArtifact[],
  head: readonly LoadedArtifact[],
  coverage: readonly ComposedGateCoverage[],
): PathAdmission | null {
  if (!storyCovers(story, path)) return null;
  const builtin = (BUILTIN_PRESENTATION_EXTENSIONS as readonly string[]).includes(
    pathExtension(path),
  );
  if (builtin && ![...base, ...head].every((a) => withinRestriction(path, a))) return null;
  // Supplier class semantics keep stamped extra dialects independent of builtin
  // allowlists. Admission still requires the applicable base amendment and base
  // story scope. A new head amendment cannot contribute admission.
  const amendment = base.find(
    (a) =>
      !builtin &&
      a.artifact.extensionAmendment?.extensions.includes(pathExtension(path)) &&
      (a.rel === story.rel || !a.rel.endsWith(".xbrief.json")) &&
      withinRestriction(path, a) &&
      head.some((h) => h.rel === a.rel && withinRestriction(path, h)),
  );
  if (!builtin && amendment === undefined) return null;
  const amendmentAdmission: PathAdmission | null =
    amendment === undefined
      ? null
      : {
          path,
          ruleId: "presentation-extension-amendment",
          authority: `${snapshot.mergeBase}:${amendment.rel}#extensionAmendment`,
          planId: story.planId,
        };
  const kind = isProductionSourcePath(path) ? "intent" : isMarkupPath(path) ? "observable" : null;
  if (kind === null) return amendmentAdmission;
  const gateId = kind === "intent" ? "verify:intent-constraint" : "verify:observable-scope";
  const c = coverage.find((g) => g.gateId === gateId);
  if (
    c?.code !== 0 ||
    c.status !== "evaluated" ||
    !c.analyzedPaths.includes(path) ||
    c.cannotEvaluatePaths.includes(path)
  )
    return null;
  const mint = scopedMint(snapshot, story, kind);
  if ("error" in mint) return mint.absent === true ? amendmentAdmission : null;
  const common = {
    projectRoot: snapshot.projectRoot,
    mergeBase: snapshot.mergeBase,
    changedFiles: [path],
    readAtBase: snapshot.base.read,
    readAtHead: snapshot.head.read,
    planId: story.planId,
    recordTextsAtBase: mint.records,
    quiet: true,
  };
  const checked =
    kind === "intent"
      ? evaluateIntentConstraint(common)
      : evaluateObservableScope({
          ...common,
          policyTextAtBase: snapshot.base.read(".deft/observable-ui.policy.json"),
        });
  if (
    checked.code !== 0 ||
    checked.skipped === true ||
    !checked.analyzedPaths?.includes(path) ||
    checked.findings?.length
  )
    return null;
  return {
    path,
    ruleId: kind === "intent" ? "intent-constraint-mint" : "observable-scope-mint",
    authority: `${snapshot.mergeBase}:${mint.authority}`,
    ...(amendmentAdmission === null ? {} : { prerequisiteAuthority: amendmentAdmission.authority }),
    planId: story.planId,
  };
}
export function evaluatePresentationCoverage(
  options: EvaluatePresentationCoverageOptions = {},
): PresentationCoverageEvaluateResult {
  const snapshot =
    options.snapshot ??
    loadSnapshot({
      projectRoot: resolve(options.projectRoot ?? "."),
      originRef: options.originRef,
      staged: options.staged,
    });
  if ("error" in snapshot) return result(2, snapshot.error, OFF);
  const base = loadArtifactsFromTexts(readTexts(snapshot.base, isCeilingArtifactRel));
  const head = loadArtifactsFromTexts(readTexts(snapshot.head, isCeilingArtifactRel));
  const readErrors = () => [...snapshot.base.errors, ...snapshot.head.errors];
  if (readErrors().length > 0) return result(2, readErrors().join("; "), OFF);
  if ("error" in base) return result(2, base.error, OFF);
  if ("error" in head) return result(2, head.error, OFF);
  const compare = compareRestrictions(base.loaded, head.loaded);
  if (!compare.armed)
    return result(
      0,
      "off-ceiling; no recorded presentation restriction. Required gates retain their independent behavior.",
      compare,
    );
  const product = snapshot.changed.filter((p) => !compare.artifactRels.includes(p));
  if (compare.refuseWeakenOrRemove) {
    const stampedRemoval =
      compare.kind === "removal" &&
      product.length === 0 &&
      base.loaded
        .filter((b) => !head.loaded.some((h) => h.rel === b.rel))
        .every((b) => b.artifact.removalStamp !== null);
    if (!stampedRemoval)
      return result(
        1,
        `refuse ${compare.kind}: head approval cannot relax merge-base restrictions.`,
        compare,
        [],
        snapshot.changed,
      );
  }
  const story = currentStory(snapshot, options.planId);
  const actual = (options.gateRunner ?? runComposedGates)(
    snapshot,
    "error" in story ? options.planId : story.planId,
  );
  const coverage = COMPOSED_GATE_IDS.map((gateId) => {
    const matching = actual.filter((c) => c.gateId === gateId);
    return matching.length === 1
      ? matching[0]!
      : {
          gateId,
          status: "unrun" as const,
          code: null,
          analyzedPaths: [],
          cannotEvaluatePaths: snapshot.changed,
          message: "required gate missing or duplicate",
        };
  });
  if (readErrors().length > 0)
    return result(2, readErrors().join("; "), compare, coverage, product);
  const bad = coverage.filter((g) => g.code !== 0 || g.status === "unrun");
  if (bad.length > 0)
    return result(
      bad.some((g) => g.code === 2 || g.code === null || g.status === "unrun") ? 2 : 1,
      `required checks did not pass: ${bad.map((g) => `${g.gateId} (${g.status}, code=${g.code}): ${g.message}`).join("; ")}`,
      compare,
      coverage,
      product,
    );
  if (product.length === 0)
    return result(
      0,
      "restriction-only candidate; all required evaluators completed.",
      compare,
      coverage,
    );
  const admissions: PathAdmission[] = [];
  const uncovered: string[] = [];
  for (const path of product) {
    const a =
      "error" in story ? null : admit(snapshot, path, story, base.loaded, head.loaded, coverage);
    if (a === null) uncovered.push(path);
    else admissions.push(a);
  }
  if (readErrors().length > 0)
    return result(2, readErrors().join("; "), compare, coverage, product);
  if (uncovered.length > 0)
    return result(
      1,
      `cannot evaluate/admit: ${uncovered
        .map(
          (p) =>
            `${p} [${
              coverage
                .filter((g) => g.cannotEvaluatePaths.includes(p))
                .map((g) => g.gateId)
                .join(", ") || "no base admission rule"
            }]`,
        )
        .join("; ")}${"error" in story ? `; ${story.error}` : ""}`,
      compare,
      coverage,
      uncovered,
      admissions,
    );
  return result(
    0,
    `continue: ${admissions.map((a) => `${a.path} [${a.ruleId}; ${a.authority}]`).join("; ")}`,
    compare,
    coverage,
    [],
    admissions,
  );
}
