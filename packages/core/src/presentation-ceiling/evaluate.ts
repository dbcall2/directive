/**
 * verify:presentation-ceiling evaluation (#5056).
 *
 * Sibling of intent-constraint / class-checks. Arms from merge-base ceiling
 * artifacts (and first-PR head-only `changeClass: presentation` adds).
 * Returned failures only — no throw/reject/abort sites.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMarkupPath } from "../observable-scope/extract.js";
import { isUnderConfiguredRoot } from "../scope-provenance/base-fence.js";
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import { unquoteGitPath } from "../scope-provenance/evaluate.js";
import {
  DEFAULT_FIXTURE_ROOTS,
  DEFAULT_TEST_ROOTS,
  loadTestBoundaryPolicy,
} from "../test-boundary/policy.js";
import {
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
  type PresentationExtensionAmendment,
  type PresentationHumanApproval,
  REMOVAL_REMEDIATION,
  WEAKEN_REMEDIATION,
} from "./types.js";

const UNEVALUATED_NOTE =
  "Intent-constraint N/A or no-new-facts cannot be cited as ceiling evidence (#5056).";

const CSS_EXT = ".css";
const JSON_EXT = ".json";
const CHANGELOG_REL = "CHANGELOG.md";
const APPROVED_SCOPE_PREFIX = ".deft/approved-scope/";
const XBRIEF_PREFIX = "xbrief/";
const COMPLETED_PREFIX = "xbrief/completed/";

export interface PresentationCeilingOptions {
  readonly baseRef?: string | null;
  readonly snapshot?: PresentationCeilingSnapshot;
  readonly quiet?: boolean;
}

type GitRun =
  | { readonly ok: true; readonly status: number; readonly stdout: string }
  | { readonly ok: false; readonly kind: "not-found" | "spawn-error"; readonly message: string };

function git(args: readonly string[], cwd: string): GitRun {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ok: false, kind: "not-found", message: "'git' executable not found on PATH" };
    }
    return {
      ok: false,
      kind: "spawn-error",
      message: `git ${args[0]} failed: ${String(e.message)}`,
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return {
      ok: false,
      kind: "spawn-error",
      message: `git ${args[0]} killed by signal ${String(result.signal)}`,
    };
  }
  return { ok: true, status: result.status ?? 1, stdout: String(result.stdout ?? "") };
}

export function normalizeRepoRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

export function pathExtension(relPath: string): string {
  const base = normalizeRepoRelPath(relPath).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isCssPath(relPath: string): boolean {
  return pathExtension(relPath) === CSS_EXT;
}

export function isBuiltinPresentationPath(relPath: string): boolean {
  return isMarkupPath(relPath) || isCssPath(relPath);
}

export function isGateToolingPath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  for (const prefix of GATE_TOOLING_PREFIXES) {
    if (posix === prefix || posix.startsWith(prefix)) return true;
  }
  return false;
}

export function isApprovedScopeRecordPath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (!posix.startsWith(APPROVED_SCOPE_PREFIX)) return false;
  if (posix.endsWith(".bak") || posix.endsWith(".tmp") || posix.endsWith(".lock.tmp")) {
    return false;
  }
  return pathExtension(posix) === JSON_EXT;
}

export function isExtraCeremonyPath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (posix === "AGENTS.md") return true;
  if (posix === "docs" || posix.startsWith("docs/")) return true;
  if (posix === "content/docs" || posix.startsWith("content/docs/")) return true;
  if (posix === ".deft/core" || posix.startsWith(".deft/core/")) return true;
  return false;
}

function humanStamp(raw: unknown): PresentationHumanApproval | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== "string" || typeof obj.actor !== "string") return null;
  if (typeof obj.mintedAt !== "string") return null;
  const stamp: PresentationHumanApproval = {
    kind: obj.kind,
    actor: obj.actor,
    mintedAt: obj.mintedAt,
    mintedVia: typeof obj.mintedVia === "string" ? obj.mintedVia : undefined,
  };
  return isHumanApprovalStamp(stamp) ? stamp : null;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t.length === 0) continue;
    out.push(t.startsWith(".") ? t.toLowerCase() : t);
  }
  return out;
}

function parseChangeClassObject(
  raw: Record<string, unknown>,
  path: string,
): PresentationCeilingArtifact | null {
  const changeClass = raw.changeClass;
  if (changeClass !== PRESENTATION_CHANGE_CLASS) return null;
  const amendmentRaw = raw.extensionAmendment;
  let extensionAmendment: PresentationExtensionAmendment | null = null;
  if (amendmentRaw !== null && typeof amendmentRaw === "object" && !Array.isArray(amendmentRaw)) {
    const rec = amendmentRaw as Record<string, unknown>;
    const stamp = humanStamp(rec.humanApproval);
    if (stamp !== null) {
      extensionAmendment = { extensions: stringList(rec.extensions), humanApproval: stamp };
    }
  }
  return {
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: PRESENTATION_CHANGE_CLASS,
    path,
    allowedExtensions: stringList(raw.allowedExtensions ?? raw.allowlist),
    componentRoots: stringList(raw.componentRoots),
    extensionAmendment,
    removalStamp: humanStamp(raw.removalStamp ?? raw.humanApproval),
  };
}

export function parseCeilingPayload(
  payload: unknown,
  path: string,
): PresentationCeilingArtifact | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  if (obj.changeClass === PRESENTATION_CHANGE_CLASS) {
    return parseChangeClassObject(obj, path);
  }
  const plan = obj.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return null;
  const planRec = plan as Record<string, unknown>;
  const keyed = planRec[PRESENTATION_CEILING_PLAN_KEY];
  if (typeof keyed === "string" && keyed === PRESENTATION_CHANGE_CLASS) {
    return parseChangeClassObject({ changeClass: PRESENTATION_CHANGE_CLASS }, path);
  }
  if (keyed !== null && typeof keyed === "object" && !Array.isArray(keyed)) {
    return parseChangeClassObject(keyed as Record<string, unknown>, path);
  }
  const metadata = planRec.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const metaKeyed = (metadata as Record<string, unknown>)[PRESENTATION_CEILING_PLAN_KEY];
    if (typeof metaKeyed === "string" && metaKeyed === PRESENTATION_CHANGE_CLASS) {
      return parseChangeClassObject({ changeClass: PRESENTATION_CHANGE_CLASS }, path);
    }
    if (metaKeyed !== null && typeof metaKeyed === "object" && !Array.isArray(metaKeyed)) {
      return parseChangeClassObject(metaKeyed as Record<string, unknown>, path);
    }
  }
  return null;
}

export function effectivePresentationExts(
  baseArtifacts: readonly PresentationCeilingArtifact[],
): ReadonlySet<string> {
  const builtin = new Set<string>(BUILTIN_PRESENTATION_EXTS);
  const out = new Set<string>(builtin);
  let sawAllowlist = false;
  const allow = new Set<string>();
  for (const art of baseArtifacts) {
    if (art.allowedExtensions.length > 0) {
      sawAllowlist = true;
      for (const ext of art.allowedExtensions) {
        const n = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
        if (builtin.has(n)) allow.add(n);
      }
    }
    if (art.extensionAmendment !== null) {
      for (const ext of art.extensionAmendment.extensions) {
        const n = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
        if (n.length > 0) out.add(n);
      }
    }
  }
  if (sawAllowlist) {
    const narrowed = new Set<string>();
    for (const ext of out) {
      if (builtin.has(ext)) {
        if (allow.has(ext)) narrowed.add(ext);
      } else {
        narrowed.add(ext);
      }
    }
    return narrowed;
  }
  return out;
}

function intersectRoots(defaults: readonly string[], base: readonly string[]): readonly string[] {
  if (base.length === 0) return defaults;
  const baseSet = new Set(base.map((r) => r.replace(/\\/g, "/")));
  return defaults.filter((d) => baseSet.has(d.replace(/\\/g, "/")));
}

function isJsonExemptCandidate(relPath: string, snapshot: PresentationCeilingSnapshot): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (isApprovedScopeRecordPath(posix)) return true;
  if (snapshot.baseActiveXbriefPath !== null && posix === snapshot.baseActiveXbriefPath) {
    return true;
  }
  for (const art of snapshot.baseArtifacts) {
    if (posix === art.path) return true;
  }
  for (const art of snapshot.headArtifacts) {
    if (posix === art.path) return true;
  }
  return false;
}

function mentionsExemptPath(content: string, exemptPath: string): boolean {
  if (content.includes(exemptPath)) return true;
  if (exemptPath.startsWith(APPROVED_SCOPE_PREFIX) && content.includes(APPROVED_SCOPE_PREFIX)) {
    return true;
  }
  return false;
}

function hasLoaderCall(content: string): boolean {
  for (const name of LOADER_NAMES) {
    if (content.includes(`${name}(`)) return true;
  }
  return false;
}

function hasDynamicExemptConstruction(content: string): boolean {
  const mentions =
    content.includes(APPROVED_SCOPE_PREFIX) ||
    (content.includes(".deft/") && content.includes("approved-scope")) ||
    content.includes(XBRIEF_PREFIX) ||
    content.includes("presentation-ceiling");
  if (!mentions) return false;
  if (content.includes("${")) return true;
  if (content.includes(" + ") || content.includes("+ '") || content.includes('+"')) return true;
  if (content.includes("join(") || content.includes("path.join")) return true;
  return false;
}

function standingNonGateHits(
  snapshot: PresentationCeilingSnapshot,
  predicate: (path: string, content: string) => boolean,
): string[] {
  const hits: string[] = [];
  for (const [rawPath, content] of snapshot.standingFileContents.entries()) {
    const path = normalizeRepoRelPath(rawPath);
    if (isGateToolingPath(path)) continue;
    if (predicate(path, content)) hits.push(path);
  }
  return hits;
}

function changelogHasProductionReader(snapshot: PresentationCeilingSnapshot): boolean {
  const readers = standingNonGateHits(snapshot, (path, content) => {
    if (isBuiltinPresentationPath(path)) return false;
    return content.includes(CHANGELOG_REL) || content.includes("CHANGELOG");
  });
  return readers.length > 0;
}

function jsonExemptionPulled(
  relPath: string,
  snapshot: PresentationCeilingSnapshot,
): PresentationCeilingFinding | null {
  const posix = normalizeRepoRelPath(relPath);
  const loaderHits = standingNonGateHits(snapshot, (_path, content) => hasLoaderCall(content));
  if (loaderHits.length > 0) {
    return {
      kind: "json-exemption-referenced",
      path: posix,
      detail:
        `non-gate loader-output consumption (${loaderHits.join(", ")}) of ${posix}; ` +
        "JSON exemption does not hold",
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  const refHits = standingNonGateHits(snapshot, (_path, content) =>
    mentionsExemptPath(content, posix),
  );
  if (refHits.length > 0) {
    return {
      kind: "json-exemption-referenced",
      path: posix,
      detail: `non-gate reference to ${posix} from ${refHits.join(", ")}`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  const dynamicHits = standingNonGateHits(snapshot, (_path, content) =>
    hasDynamicExemptConstruction(content),
  );
  if (dynamicHits.length > 0) {
    return {
      kind: "dynamic-exempt-path",
      path: posix,
      detail: `dynamic construction of an exempt JSON path in non-gate code (${dynamicHits.join(", ")})`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  return null;
}

function artifactByPath(
  artifacts: readonly PresentationCeilingArtifact[],
): Map<string, PresentationCeilingArtifact> {
  const map = new Map<string, PresentationCeilingArtifact>();
  for (const art of artifacts) map.set(normalizeRepoRelPath(art.path), art);
  return map;
}

function isXbriefPath(relPath: string): boolean {
  return normalizeRepoRelPath(relPath).startsWith(XBRIEF_PREFIX);
}

function isCompletedXbrief(relPath: string): boolean {
  return normalizeRepoRelPath(relPath).startsWith(COMPLETED_PREFIX);
}

export function evaluatePresentationCeilingFromSnapshot(
  snapshot: PresentationCeilingSnapshot,
): PresentationCeilingResult {
  const changed = snapshot.changedFiles.map(normalizeRepoRelPath).filter((p) => p.length > 0);
  const baseMap = artifactByPath(snapshot.baseArtifacts);
  const headMap = artifactByPath(snapshot.headArtifacts);
  const headAddsRestriction = snapshot.headArtifacts.some((art) => !baseMap.has(art.path));
  const armed = snapshot.baseArtifacts.length > 0 || headAddsRestriction;

  if (!armed) {
    return {
      exitCode: 0,
      findings: [],
      message: `${GATE_ID}: skipped — no recorded presentation ceiling at merge-base or head restriction add. ${UNEVALUATED_NOTE}`,
      armed: false,
      evaluatedPaths: changed,
      unevaluatedNote: UNEVALUATED_NOTE,
    };
  }

  const findings: PresentationCeilingFinding[] = [];
  const productPaths = changed.filter((p) => {
    if (baseMap.has(p) || headMap.has(p)) return false;
    if (p === snapshot.baseActiveXbriefPath) return false;
    return true;
  });

  for (const [basePath, baseArt] of baseMap.entries()) {
    if (headMap.has(basePath)) {
      continue;
    }
    if (snapshot.headFileContents.has(basePath)) {
      findings.push({
        kind: "ceiling-weaken",
        path: basePath,
        detail: "same-PR weaken of a merge-base presentation ceiling",
        remediation: WEAKEN_REMEDIATION,
      });
      continue;
    }
    const authorized = baseArt.removalStamp !== null;
    if (!authorized) {
      findings.push({
        kind: "ceiling-removal",
        path: basePath,
        detail:
          productPaths.length > 0
            ? `ceiling-bound path removed/moved and mixed with product paths (${productPaths.join(", ")})`
            : "ceiling-bound path removed or renamed without a merge-base removal stamp",
        remediation: REMOVAL_REMEDIATION,
      });
    } else if (productPaths.length > 0) {
      findings.push({
        kind: "ceiling-removal",
        path: basePath,
        detail: `removal stamp cannot mix with product paths (${productPaths.join(", ")})`,
        remediation: REMOVAL_REMEDIATION,
      });
    }
  }

  const effectiveExts = effectivePresentationExts(snapshot.baseArtifacts);
  const testRoots = intersectRoots(snapshot.defaultTestRoots, snapshot.baseTestRoots);
  const fixtureRoots = intersectRoots(snapshot.defaultFixtureRoots, snapshot.baseFixtureRoots);
  const changelogReader = changelogHasProductionReader(snapshot);

  for (const rel of changed) {
    if (isCompletedXbrief(rel) && !isBuiltinPresentationPath(rel)) {
      findings.push({
        kind: "out-of-class-path",
        path: rel,
        detail: "xBRIEF completed-path is not exempt under a presentation ceiling",
        remediation: PRESENTATION_CEILING_REMEDIATION,
      });
      continue;
    }

    if (rel === CHANGELOG_REL) {
      if (changelogReader) {
        findings.push({
          kind: "changelog-production-reader",
          path: rel,
          detail:
            "CHANGELOG.md exemption does not hold while a non-gate production reader is present",
          remediation: PRESENTATION_CEILING_REMEDIATION,
        });
      }
      continue;
    }

    if (isJsonExemptCandidate(rel, snapshot)) {
      const pulled = jsonExemptionPulled(rel, snapshot);
      if (pulled !== null) findings.push(pulled);
      continue;
    }

    const ext = pathExtension(rel);
    if (effectiveExts.has(ext) && isBuiltinPresentationPath(rel)) {
      continue;
    }
    if (effectiveExts.has(ext) && !isBuiltinPresentationPath(rel)) {
      continue;
    }

    const underTestOrFixture =
      isUnderConfiguredRoot(rel, testRoots) || isUnderConfiguredRoot(rel, fixtureRoots);
    if (underTestOrFixture && isBuiltinPresentationPath(rel)) {
      continue;
    }

    if (baseMap.has(rel) || headMap.has(rel)) {
      continue;
    }

    if (isExtraCeremonyPath(rel)) {
      findings.push({
        kind: "extra-ceremony",
        path: rel,
        detail: "presentation-story ceremony is fail-closed extra ceremony, not P1",
        remediation: EXTRA_CEREMONY_REMEDIATION,
      });
      continue;
    }

    if (isXbriefPath(rel) && rel === snapshot.baseActiveXbriefPath) {
      continue;
    }

    findings.push({
      kind: "out-of-class-path",
      path: rel,
      detail:
        `changed path ${rel} is outside the built-in presentation extension set ` +
        `(ext=${ext || "none"}) under a recorded presentation ceiling`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    });
  }

  if (findings.length === 0) {
    return {
      exitCode: 0,
      findings: [],
      message: `${GATE_ID}: pass — ${String(changed.length)} changed path(s) within the presentation ceiling. ${UNEVALUATED_NOTE}`,
      armed: true,
      evaluatedPaths: changed,
      unevaluatedNote: UNEVALUATED_NOTE,
    };
  }

  const listed = findings.map((f) => `${f.kind}:${f.path}`).join("; ");
  return {
    exitCode: 1,
    findings,
    message: `${GATE_ID}: FAIL — ${String(findings.length)} finding(s): ${listed}. ${UNEVALUATED_NOTE}`,
    armed: true,
    evaluatedPaths: changed,
    unevaluatedNote: UNEVALUATED_NOTE,
  };
}

function configResult(message: string): PresentationCeilingResult {
  return {
    exitCode: 2,
    findings: [],
    message,
    armed: false,
    evaluatedPaths: [],
    unevaluatedNote: UNEVALUATED_NOTE,
  };
}

function skipNotGit(message: string): PresentationCeilingResult {
  return {
    exitCode: 0,
    findings: [],
    message: `${GATE_ID}: skipped — ${message}`,
    armed: false,
    evaluatedPaths: [],
    unevaluatedNote: UNEVALUATED_NOTE,
  };
}

export function resolvePresentationCeilingBaseRef(projectRoot: string): string | null {
  const envCandidates = [
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    const ran = git(["rev-parse", "--verify", "-q", cand], projectRoot);
    if (!ran.ok) {
      if (ran.kind === "not-found") return null;
      continue;
    }
    if (ran.status === 0) return cand;
  }
  return null;
}

function changedFilesVsBase(
  projectRoot: string,
  baseRef: string,
): { ok: true; files: string[] } | { ok: false; message: string; skip?: boolean } {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (!inside.ok) {
    if (inside.kind === "not-found") {
      return { ok: false, message: inside.message };
    }
    return { ok: false, message: inside.message };
  }
  if (inside.status !== 0) {
    return { ok: false, message: "not a git working tree", skip: true };
  }
  const out = new Set<string>();
  const addPath = (raw: string): void => {
    const t = normalizeRepoRelPath(unquoteGitPath(raw));
    if (t.length > 0) out.add(t);
  };
  const range = `${baseRef}...HEAD`;
  const diff = git(["diff", "--name-only", range], projectRoot);
  if (!diff.ok) return { ok: false, message: diff.message };
  if (diff.status !== 0) {
    return {
      ok: false,
      message: `git diff --name-only ${range} failed (exit ${String(diff.status)})`,
    };
  }
  for (const line of diff.stdout.split("\n")) addPath(line);
  const vsHead = git(["diff", "--name-only", "HEAD"], projectRoot);
  if (!vsHead.ok) return { ok: false, message: vsHead.message };
  if (vsHead.status !== 0) {
    return {
      ok: false,
      message: `git diff --name-only HEAD failed (exit ${String(vsHead.status)})`,
    };
  }
  for (const line of vsHead.stdout.split("\n")) addPath(line);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (!untracked.ok) return { ok: false, message: untracked.message };
  if (untracked.status !== 0) {
    return {
      ok: false,
      message: `git ls-files --others --exclude-standard failed (exit ${String(untracked.status)})`,
    };
  }
  for (const line of untracked.stdout.split("\n")) addPath(line);
  return { ok: true, files: [...out] };
}

function readAtRef(projectRoot: string, ref: string, relPath: string): string | null {
  const path = normalizeRepoRelPath(relPath);
  const result = git(["show", `${ref}:${path}`], projectRoot);
  if (!result.ok || result.status !== 0) return null;
  return result.stdout;
}

function listCeilingTreeAtRef(projectRoot: string, ref: string): string[] {
  const listed = git(
    [
      "ls-tree",
      "-r",
      "--name-only",
      ref,
      "--",
      "xbrief/active",
      "xbrief/pending",
      "xbrief/proposed",
      PRESENTATION_CEILING_ARTIFACT_REL,
    ],
    projectRoot,
  );
  if (!listed.ok || listed.status !== 0) return [];
  return listed.stdout
    .split("\n")
    .map((l) => normalizeRepoRelPath(l))
    .filter((p) => p.length > 0);
}

function parseJsonText(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isCeilingCandidatePath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (posix === PRESENTATION_CEILING_ARTIFACT_REL) return true;
  if (posix.endsWith("/presentation-ceiling.json")) return true;
  if (posix.startsWith("xbrief/active/") && posix.endsWith(".xbrief.json")) return true;
  if (posix.startsWith("xbrief/pending/") && posix.endsWith(".xbrief.json")) return true;
  if (posix.startsWith("xbrief/proposed/") && posix.endsWith(".xbrief.json")) return true;
  return false;
}

function grepCeilingHits(projectRoot: string, ref: string | null): string[] {
  const args =
    ref === null
      ? [
          "grep",
          "-I",
          "-l",
          "-F",
          "-e",
          `"changeClass": "${PRESENTATION_CHANGE_CLASS}"`,
          "-e",
          PRESENTATION_CEILING_SCHEMA,
        ]
      : [
          "grep",
          "-I",
          "-l",
          "-F",
          "-e",
          `"changeClass": "${PRESENTATION_CHANGE_CLASS}"`,
          "-e",
          PRESENTATION_CEILING_SCHEMA,
          ref,
        ];
  const ran = git(args, projectRoot);
  if (!ran.ok || ran.status !== 0) return [];
  const out: string[] = [];
  for (const line of ran.stdout.split("\n")) {
    const stripped = ref !== null ? line.replace(new RegExp(`^${ref}:`), "") : line;
    const p = normalizeRepoRelPath(stripped);
    if (p.length > 0) out.push(p);
  }
  return out;
}

function collectArtifactsFromListing(
  projectRoot: string,
  ref: string | null,
  names: readonly string[],
  headContents?: ReadonlyMap<string, string>,
): PresentationCeilingArtifact[] {
  const out: PresentationCeilingArtifact[] = [];
  for (const name of names) {
    const posix = normalizeRepoRelPath(name);
    if (!isCeilingCandidatePath(posix)) continue;
    let text: string | null = null;
    if (headContents?.has(posix)) {
      text = headContents.get(posix) ?? null;
    } else if (ref !== null) {
      text = readAtRef(projectRoot, ref, posix);
    } else {
      const abs = join(projectRoot, posix);
      if (existsSync(abs)) {
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          text = null;
        }
      }
    }
    if (text === null) continue;
    const payload = parseJsonText(text);
    const art = parseCeilingPayload(payload, posix);
    if (art !== null) out.push(art);
  }
  return out;
}

function collectHeadContents(projectRoot: string, names: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    const posix = normalizeRepoRelPath(name);
    const abs = join(resolve(projectRoot), posix);
    if (!existsSync(abs)) continue;
    try {
      map.set(posix, readFileSync(abs, "utf8"));
    } catch {
      // skip unreadable
    }
  }
  return map;
}

function collectStandingContents(
  projectRoot: string,
  baseRef: string,
  changed: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  const patterns = [
    "approved-scope",
    "readApprovedScopeRecord",
    "loadRecord",
    "listApprovedScopeRecords",
    "CHANGELOG.md",
    "presentation-ceiling",
    "seedSql",
    "xbrief/",
  ];
  const grepArgs = ["grep", "-I", "-l", "-F", "-e", patterns[0] ?? "approved-scope"];
  for (const extra of patterns.slice(1)) {
    grepArgs.push("-e", extra);
  }
  const headGrep = git([...grepArgs], projectRoot);
  if (headGrep.ok && headGrep.status === 0) {
    for (const line of headGrep.stdout.split("\n")) {
      const p = normalizeRepoRelPath(line);
      if (p.length === 0) continue;
      const abs = join(resolve(projectRoot), p);
      if (!existsSync(abs)) continue;
      try {
        map.set(p, readFileSync(abs, "utf8"));
      } catch {
        // skip
      }
    }
  }
  const baseGrep = git(
    ["grep", "-I", "-l", "-F", "-e", patterns[0] ?? "approved-scope", baseRef],
    projectRoot,
  );
  // git grep <ref> syntax: git grep -e PAT REF
  const baseGrep2 = git(
    [
      "grep",
      "-I",
      "-l",
      "-F",
      "-e",
      "approved-scope",
      "-e",
      "readApprovedScopeRecord",
      "-e",
      "loadRecord",
      "-e",
      "listApprovedScopeRecords",
      "-e",
      "CHANGELOG.md",
      "-e",
      "presentation-ceiling",
      "-e",
      "seedSql",
      baseRef,
    ],
    projectRoot,
  );
  const baseOut =
    baseGrep2.ok && baseGrep2.status === 0 ? baseGrep2.stdout : baseGrep.ok ? baseGrep.stdout : "";
  for (const line of baseOut.split("\n")) {
    const p = normalizeRepoRelPath(line.replace(new RegExp(`^${baseRef}:`), ""));
    if (p.length === 0) continue;
    if (map.has(p)) continue;
    const text = readAtRef(projectRoot, baseRef, p);
    if (text !== null) map.set(p, text);
  }
  for (const rel of changed) {
    const posix = normalizeRepoRelPath(rel);
    if (map.has(posix)) continue;
    const abs = join(resolve(projectRoot), posix);
    if (existsSync(abs)) {
      try {
        map.set(posix, readFileSync(abs, "utf8"));
      } catch {
        // skip
      }
    }
  }
  return map;
}

function activeXbriefAtRef(names: readonly string[]): string | null {
  const actives = names
    .map(normalizeRepoRelPath)
    .filter((p) => p.startsWith("xbrief/active/") && p.endsWith(".xbrief.json"));
  if (actives.length === 1) return actives[0] ?? null;
  return actives.length > 0 ? (actives[0] ?? null) : null;
}

function loadBaseRoots(
  projectRoot: string,
  baseRef: string,
): { testRoots: readonly string[]; fixtureRoots: readonly string[] } {
  const policyText = readAtRef(projectRoot, baseRef, ".deft/test-boundary.policy.json");
  if (policyText === null) {
    return { testRoots: DEFAULT_TEST_ROOTS, fixtureRoots: DEFAULT_FIXTURE_ROOTS };
  }
  try {
    const parsed = JSON.parse(policyText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { testRoots: DEFAULT_TEST_ROOTS, fixtureRoots: DEFAULT_FIXTURE_ROOTS };
    }
    const rec = parsed as Record<string, unknown>;
    const testRoots = Array.isArray(rec.testRoots)
      ? rec.testRoots.filter((x): x is string => typeof x === "string")
      : [];
    const fixtureRoots = Array.isArray(rec.fixtureRoots)
      ? rec.fixtureRoots.filter((x): x is string => typeof x === "string")
      : [];
    return {
      testRoots: testRoots.length > 0 ? testRoots : DEFAULT_TEST_ROOTS,
      fixtureRoots: fixtureRoots.length > 0 ? fixtureRoots : DEFAULT_FIXTURE_ROOTS,
    };
  } catch {
    return { testRoots: DEFAULT_TEST_ROOTS, fixtureRoots: DEFAULT_FIXTURE_ROOTS };
  }
}

/**
 * Evaluate the presentation-ceiling gate against a git worktree, or an injected snapshot.
 */
export function evaluatePresentationCeiling(
  projectRoot: string,
  options: PresentationCeilingOptions = {},
): PresentationCeilingResult {
  if (options.snapshot !== undefined) {
    return evaluatePresentationCeilingFromSnapshot(options.snapshot);
  }

  const root = resolve(projectRoot);
  const resolved = options.baseRef ?? resolvePresentationCeilingBaseRef(root);
  if (resolved === null) {
    return configResult(
      `${GATE_ID}: no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF); pass --base-ref`,
    );
  }
  const changed = changedFilesVsBase(root, resolved);
  if (!changed.ok) {
    if (changed.skip) return skipNotGit(changed.message);
    return configResult(`${GATE_ID}: ${changed.message}`);
  }

  const baseNames = [
    ...new Set([
      PRESENTATION_CEILING_ARTIFACT_REL,
      ...grepCeilingHits(root, resolved),
      ...listCeilingTreeAtRef(root, resolved),
    ]),
  ];
  const headCandidates = [
    ...new Set([
      PRESENTATION_CEILING_ARTIFACT_REL,
      ...grepCeilingHits(root, null),
      ...changed.files.filter(isCeilingCandidatePath),
    ]),
  ];
  const headContents = collectHeadContents(root, headCandidates);
  const baseArtifacts = collectArtifactsFromListing(root, resolved, baseNames);
  const headArtifacts = collectArtifactsFromListing(root, null, headCandidates, headContents);
  const headAddsRestriction = headArtifacts.some(
    (art) => !baseArtifacts.some((b) => b.path === art.path),
  );
  if (baseArtifacts.length === 0 && !headAddsRestriction) {
    return evaluatePresentationCeilingFromSnapshot({
      changedFiles: changed.files,
      baseArtifacts: [],
      headArtifacts: [],
      baseActiveXbriefPath: null,
      headFileContents: headContents,
      standingFileContents: new Map(),
      baseTestRoots: [],
      baseFixtureRoots: [],
      defaultTestRoots: DEFAULT_TEST_ROOTS,
      defaultFixtureRoots: DEFAULT_FIXTURE_ROOTS,
    });
  }
  const standing = collectStandingContents(root, resolved, changed.files);
  const baseRoots = loadBaseRoots(root, resolved);
  let defaultTest = DEFAULT_TEST_ROOTS;
  let defaultFixture = DEFAULT_FIXTURE_ROOTS;
  try {
    const live = loadTestBoundaryPolicy(root);
    defaultTest = live.testRoots;
    defaultFixture = live.fixtureRoots;
  } catch {
    // defaults
  }

  const snapshot: PresentationCeilingSnapshot = {
    changedFiles: changed.files,
    baseArtifacts,
    headArtifacts,
    baseActiveXbriefPath: activeXbriefAtRef(listCeilingTreeAtRef(root, resolved)),
    headFileContents: headContents,
    standingFileContents: standing,
    baseTestRoots: baseRoots.testRoots,
    baseFixtureRoots: baseRoots.fixtureRoots,
    defaultTestRoots: defaultTest,
    defaultFixtureRoots: defaultFixture,
  };
  return evaluatePresentationCeilingFromSnapshot(snapshot);
}
