/**
 * Presentation-ceiling compositor (#5079).
 *
 * Under an armed presentation ceiling, cannot-evaluate on a composed required
 * gate is refuse or escalate, never pass. Arming runs before gate N/A.
 */

import { execFileSync } from "node:child_process";
import { formatDegradedSkipReport } from "../check/named-cause.js";
import { REQUIRED_CONSUMER_ENFORCEMENT_GATES } from "../consumer-check-contract/evaluate.js";
import { resolveDefaultBaseRef } from "../evaluator-surface/evaluate.js";
import {
  evaluateIntentConstraint,
  type EvaluateResult as IntentEvaluateResult,
} from "../intent-constraint/evaluate.js";
import { isProductionSourcePath } from "../intent-constraint/extract.js";
import { parseIntentConstraintRecord } from "../intent-constraint/mint.js";
import { INTENT_CONSTRAINT_DIR } from "../intent-constraint/types.js";
import {
  evaluateObservableScope,
  type EvaluateResult as ObservableEvaluateResult,
} from "../observable-scope/evaluate.js";
import { isMarkupPath } from "../observable-scope/extract.js";
import { parseObservableScopeRecord } from "../observable-scope/mint.js";
import { OBSERVABLE_SCOPE_DIR } from "../observable-scope/types.js";
import { normalizePath } from "../orchestration/pathspec.js";
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import { listCeilingArtifactTexts } from "./artifact.js";
import { compareRestrictions, loadArtifactsFromTexts } from "./compare.js";
import { isCeilingArtifactRel, normalizeRel, pathExtension } from "./paths.js";
import {
  type AdmissionRuleId,
  CEILING_COMPOSITOR_GATE_ID,
  CEILING_COMPOSITOR_REMEDIATION,
  type ComposedGateCoverage,
  type PresentationCeilingEvaluateResult,
  type RestrictionCompare,
} from "./types.js";

export interface EvaluatePresentationCeilingOptions {
  readonly projectRoot?: string;
  readonly originRef?: string;
  readonly staged?: boolean;
  readonly quiet?: boolean;
  readonly changedFiles?: readonly string[];
  readonly mergeBase?: string;
  readonly baseArtifacts?: ReadonlyMap<string, string>;
  readonly headArtifacts?: ReadonlyMap<string, string>;
  readonly readAtBase?: (relPath: string) => string | null;
  readonly readAtHead?: (relPath: string) => string | null;
  readonly intentResult?: IntentEvaluateResult;
  readonly observableResult?: ObservableEvaluateResult;
  readonly intentRecordsAtBase?: ReadonlyMap<string, string>;
  readonly observableRecordsAtBase?: ReadonlyMap<string, string>;
}

function runGit(projectRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function gitShow(projectRoot: string, ref: string, rel: string): string | null {
  return runGit(projectRoot, ["show", `${ref}:${rel}`]);
}

function resolveMergeBase(projectRoot: string, originRef?: string): string | { error: string } {
  if (originRef !== undefined && originRef.trim().length > 0) {
    const mb = runGit(projectRoot, ["merge-base", originRef.trim(), "HEAD"]);
    if (mb !== null && mb.length > 0) return mb;
    return { error: `could not compute merge-base against ${originRef.trim()}` };
  }
  const origin = resolveDefaultBaseRef(projectRoot);
  if (typeof origin !== "string") return origin;
  const mb = runGit(projectRoot, ["merge-base", origin, "HEAD"]);
  if (mb !== null && mb.length > 0) return mb;
  return { error: `could not compute merge-base against ${origin}` };
}

function listChanged(
  projectRoot: string,
  mergeBase: string,
  options: EvaluatePresentationCeilingOptions,
): string[] | { error: string } {
  if (options.changedFiles !== undefined) {
    return options.changedFiles.map((p) => normalizeRel(p));
  }
  const args =
    options.staged === true
      ? ["diff", "--name-only", "--cached"]
      : ["diff", "--name-only", mergeBase, "HEAD"];
  const out = runGit(projectRoot, args);
  if (out === null) return { error: "git diff --name-only failed" };
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((p) => normalizeRel(p));
}

function coverageFromIntent(
  result: IntentEvaluateResult,
  changed: readonly string[],
): ComposedGateCoverage {
  const analyzed =
    result.analyzedPaths !== undefined
      ? result.analyzedPaths.map((p) => normalizeRel(p))
      : changed.filter((p) => isProductionSourcePath(p));
  const skipped = result.skipped === true;
  return {
    gateId: "verify:intent-constraint",
    skipped,
    analyzedPaths: skipped ? [] : analyzed,
    cannotEvaluatePaths: skipped
      ? changed.filter((p) => !isProductionSourcePath(p) && !isCeilingArtifactRel(p))
      : [],
    code: result.code,
  };
}

function coverageFromObservable(
  result: ObservableEvaluateResult,
  changed: readonly string[],
): ComposedGateCoverage {
  const analyzed =
    result.analyzedPaths !== undefined
      ? result.analyzedPaths.map((p) => normalizeRel(p))
      : changed.filter((p) => isMarkupPath(p));
  const skipped = result.skipped === true;
  const warnPaths = (result.findings ?? [])
    .filter((f) => f.kind === "non-adoption" && typeof f.path === "string")
    .map((f) => normalizeRel(f.path ?? ""));
  const cannot = skipped
    ? changed.filter((p) => isMarkupPath(p) || pathExtension(p) === ".css")
    : warnPaths;
  return {
    gateId: "verify:observable-scope",
    skipped: skipped || warnPaths.length > 0,
    analyzedPaths: analyzed,
    cannotEvaluatePaths: cannot,
    code: result.code,
  };
}

function stubCoverage(gateId: string): ComposedGateCoverage {
  return {
    gateId,
    skipped: false,
    analyzedPaths: [],
    cannotEvaluatePaths: [],
    code: 0,
  };
}

function hasHumanIntentMint(texts: ReadonlyMap<string, string>): boolean {
  for (const text of texts.values()) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    const parsed = parseIntentConstraintRecord(raw);
    if ("error" in parsed) continue;
    if (isHumanApprovalStamp(parsed.humanApproval)) return true;
  }
  return false;
}

function hasHumanObservableMint(texts: ReadonlyMap<string, string>): boolean {
  for (const text of texts.values()) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    const parsed = parseObservableScopeRecord(raw);
    if ("error" in parsed) continue;
    if (isHumanApprovalStamp(parsed.humanApproval)) return true;
  }
  return false;
}

function baseExtraExtensions(
  baseLoaded: readonly { artifact: { extraExtensions: readonly string[] } }[],
): Set<string> {
  const out = new Set<string>();
  for (const item of baseLoaded) {
    for (const ext of item.artifact.extraExtensions) out.add(ext);
  }
  return out;
}

function listRecordDir(
  projectRoot: string,
  mergeBase: string,
  dir: string,
  injected: ReadonlyMap<string, string> | undefined,
  readAtBase: ((rel: string) => string | null) | undefined,
): Map<string, string> {
  if (injected !== undefined) return new Map(injected);
  const out = new Map<string, string>();
  const ls = runGit(projectRoot, ["ls-tree", "-r", "--name-only", mergeBase, dir]);
  if (ls === null || ls.length === 0) return out;
  const reader = readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase, rel));
  for (const rel of ls
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)) {
    const posix = normalizePath(rel);
    const text = reader(posix);
    if (text !== null) out.set(posix, text);
  }
  return out;
}

function admitPath(input: {
  readonly path: string;
  readonly intentCoverage: ComposedGateCoverage;
  readonly extraExtensions: ReadonlySet<string>;
  readonly intentMint: boolean;
  readonly observableMint: boolean;
}): AdmissionRuleId | null {
  const ext = pathExtension(input.path);
  if (ext.length > 0 && input.extraExtensions.has(ext)) {
    return "presentation-extension-amendment";
  }
  if (
    input.intentMint &&
    isProductionSourcePath(input.path) &&
    input.intentCoverage.analyzedPaths.includes(input.path)
  ) {
    return "intent-constraint-mint";
  }
  if (input.observableMint && isMarkupPath(input.path)) {
    return "observable-scope-mint";
  }
  return null;
}

function fail(
  message: string,
  compare: RestrictionCompare,
  uncovered: readonly string[],
  coverage: readonly ComposedGateCoverage[],
): PresentationCeilingEvaluateResult {
  return {
    code: 1,
    message: `${message} ${CEILING_COMPOSITOR_REMEDIATION}`,
    stream: "stderr",
    armed: compare.armed,
    compare,
    uncoveredPaths: uncovered,
    coverage,
  };
}

function config(message: string, compare: RestrictionCompare): PresentationCeilingEvaluateResult {
  return {
    code: 2,
    message: `${CEILING_COMPOSITOR_GATE_ID}: ${message}`,
    stream: "stderr",
    armed: compare.armed,
    compare,
    uncoveredPaths: [],
    coverage: [],
  };
}

function ok(
  message: string,
  compare: RestrictionCompare,
  coverage: readonly ComposedGateCoverage[],
  quiet: boolean,
): PresentationCeilingEvaluateResult {
  return {
    code: 0,
    message: quiet ? "" : message,
    stream: "stdout",
    skipped: !compare.armed,
    armed: compare.armed,
    compare,
    uncoveredPaths: [],
    coverage,
  };
}

/**
 * Evaluate the #5079 compositor. Composed-gate list is
 * REQUIRED_CONSUMER_ENFORCEMENT_GATES; this gate is the unavoidable fail-closed
 * merge check for an armed ceiling.
 */
export function evaluatePresentationCeiling(
  options: EvaluatePresentationCeilingOptions = {},
): PresentationCeilingEvaluateResult {
  const projectRoot = options.projectRoot ?? ".";
  const quiet = options.quiet === true;
  const emptyCompare: RestrictionCompare = {
    kind: "off-ceiling",
    armed: false,
    refuseWeakenOrRemove: false,
    artifactRels: [],
  };

  let mergeBase = options.mergeBase;
  if (mergeBase === undefined) {
    const resolved = resolveMergeBase(projectRoot, options.originRef);
    if (typeof resolved !== "string") return config(resolved.error, emptyCompare);
    mergeBase = resolved;
  }

  const changed = listChanged(projectRoot, mergeBase, options);
  if (!Array.isArray(changed)) return config(changed.error, emptyCompare);

  const readBase =
    options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase ?? "", rel));
  const readHead =
    options.readAtHead ??
    ((rel: string) => {
      if (options.staged === true) {
        const shown = runGit(projectRoot, ["show", `:${rel}`]);
        return shown;
      }
      return gitShow(projectRoot, "HEAD", rel);
    });

  const baseTexts = listCeilingArtifactTexts({
    projectRoot,
    ref: mergeBase,
    injected: options.baseArtifacts,
    read: readBase,
  });
  const headTexts = listCeilingArtifactTexts({
    projectRoot,
    ref: "HEAD",
    injected: options.headArtifacts,
    read: readHead,
  });

  const baseLoaded = loadArtifactsFromTexts(baseTexts);
  if (!baseLoaded.ok) return config(baseLoaded.error, emptyCompare);
  const headLoaded = loadArtifactsFromTexts(headTexts);
  if (!headLoaded.ok) return config(headLoaded.error, emptyCompare);

  const compare = compareRestrictions(baseLoaded.loaded, headLoaded.loaded);

  const intentResult =
    options.intentResult ??
    evaluateIntentConstraint({
      projectRoot,
      originRef: options.originRef,
      staged: options.staged,
      quiet: true,
      changedFiles: changed,
      mergeBase,
      readAtBase: readBase,
      readAtHead: readHead,
      recordTextsAtBase: options.intentRecordsAtBase,
    });
  const observableResult =
    options.observableResult ??
    evaluateObservableScope({
      projectRoot,
      originRef: options.originRef,
      staged: options.staged,
      quiet: true,
      changedFiles: changed,
      mergeBase,
      readAtBase: readBase,
      readAtHead: readHead,
      recordTextsAtBase: options.observableRecordsAtBase,
    });

  const intentCoverage = coverageFromIntent(intentResult, changed);
  const observableCoverage = coverageFromObservable(observableResult, changed);
  const otherCoverage = REQUIRED_CONSUMER_ENFORCEMENT_GATES.filter(
    (id) => id !== "verify:intent-constraint" && id !== "verify:observable-scope",
  ).map((id) => stubCoverage(id));
  const coverage: ComposedGateCoverage[] = [intentCoverage, observableCoverage, ...otherCoverage];

  if (!compare.armed) {
    return ok(
      `${CEILING_COMPOSITOR_GATE_ID}: off-ceiling — no merge-base artifact and no add-only or tightening head restriction.`,
      compare,
      coverage,
      quiet,
    );
  }

  if (compare.refuseWeakenOrRemove) {
    return fail(
      `${CEILING_COMPOSITOR_GATE_ID}: refuse — same-PR weaken or removal of a merge-base presentation ceiling is not authorized by a head stamp (${compare.kind}).`,
      compare,
      changed.filter((p) => !isCeilingArtifactRel(p)),
      coverage,
    );
  }

  const intentRecords = listRecordDir(
    projectRoot,
    mergeBase,
    INTENT_CONSTRAINT_DIR,
    options.intentRecordsAtBase,
    readBase,
  );
  const observableRecords = listRecordDir(
    projectRoot,
    mergeBase,
    OBSERVABLE_SCOPE_DIR,
    options.observableRecordsAtBase,
    readBase,
  );
  const extraExtensions = baseExtraExtensions(baseLoaded.loaded);
  const intentMint = hasHumanIntentMint(intentRecords);
  const observableMint = hasHumanObservableMint(observableRecords);

  const uncovered: string[] = [];
  const gateIdsFor = new Map<string, string[]>();
  for (const path of changed) {
    if (isCeilingArtifactRel(path)) continue;
    const admitted = admitPath({
      path,
      intentCoverage,
      extraExtensions,
      intentMint,
      observableMint,
    });
    if (admitted !== null) continue;
    uncovered.push(path);
    const gates: string[] = [];
    if (intentCoverage.skipped || !intentCoverage.analyzedPaths.includes(path)) {
      gates.push("verify:intent-constraint");
    }
    if (
      observableCoverage.skipped ||
      observableCoverage.cannotEvaluatePaths.includes(path) ||
      !observableCoverage.analyzedPaths.includes(path)
    ) {
      gates.push("verify:observable-scope");
    }
    gateIdsFor.set(path, gates.length > 0 ? gates : [...REQUIRED_CONSUMER_ENFORCEMENT_GATES]);
  }

  if (uncovered.length === 0) {
    return ok(
      `${CEILING_COMPOSITOR_GATE_ID}: continue — every changed path is admitted by a recomputed merge-base rule.`,
      compare,
      coverage,
      quiet,
    );
  }

  const listed = uncovered
    .slice(0, 8)
    .map((p) => `${p} [${(gateIdsFor.get(p) ?? []).join(", ")}]`)
    .join("; ");
  const skipLines = formatDegradedSkipReport({
    reason: "armed presentation ceiling",
    skipHeadline: "check: skipped composed gate(s) as cannot-evaluate (#5079):",
    skipped: coverage
      .filter((c) => c.skipped || c.cannotEvaluatePaths.length > 0)
      .map((c) => ({
        id: c.gateId,
        cause: c.skipped ? "skipped N/A" : "cannot-evaluate",
        remedy: CEILING_COMPOSITOR_REMEDIATION,
      })),
    failed: [CEILING_COMPOSITOR_GATE_ID],
    exitCode: 1,
  });
  return fail(
    `${CEILING_COMPOSITOR_GATE_ID}: refuse — cannot evaluate under an armed presentation ceiling: ${listed}.\n${skipLines.join("\n")}`,
    compare,
    uncovered,
    coverage,
  );
}
