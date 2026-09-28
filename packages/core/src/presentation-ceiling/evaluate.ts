/**
 * verify:presentation-ceiling evaluation (#5056).
 *
 * Sibling of intent-constraint / class-checks. Arms from merge-base ceiling
 * artifacts (and first-PR head-only `changeClass: presentation` adds).
 * Returned failures only — no throw/reject/abort sites.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type * as TypeScript from "typescript";
import { isMarkupPath } from "../observable-scope/extract.js";
import { isUnderConfiguredRoot } from "../scope-provenance/base-fence.js";
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import { DEFAULT_FIXTURE_ROOTS, DEFAULT_TEST_ROOTS } from "../test-boundary/policy.js";
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
    hasExtensionRestriction: raw.allowedExtensions !== undefined || raw.allowlist !== undefined,
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
  const allowed = new Set<string>(builtin);
  // All recorded ceilings constrain the built-in set. Explicit human amendments
  // authorize additional dialects repository-wide, independently of allowlists.
  for (const art of baseArtifacts) {
    if (art.allowedExtensions.length === 0 && !art.hasExtensionRestriction) continue;
    const restriction = new Set(art.allowedExtensions.map(normalizeExtension));
    for (const ext of allowed) {
      if (!restriction.has(ext)) allowed.delete(ext);
    }
  }
  for (const art of baseArtifacts) {
    for (const ext of art.extensionAmendment?.extensions ?? []) {
      const normalized = normalizeExtension(ext);
      if (!builtin.has(normalized)) allowed.add(normalized);
    }
  }
  return allowed;
}

function normalizeExtension(ext: string): string {
  return ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
}

function intersectRoots(defaults: readonly string[], base: readonly string[]): readonly string[] {
  const baseSet = new Set(base.map((r) => r.replace(/\\/g, "/")));
  return defaults.filter((d) => baseSet.has(d.replace(/\\/g, "/")));
}

function isJsonExemptCandidate(relPath: string, snapshot: PresentationCeilingSnapshot): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (isApprovedScopeRecordPath(posix)) return true;
  if (
    snapshot.baseActiveXbriefPaths?.includes(posix) ||
    (snapshot.baseActiveXbriefPath !== null && posix === snapshot.baseActiveXbriefPath)
  ) {
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

/**
 * Parse-only reader analysis: executable imports/calls, local path aliases and
 * approved-scope module bindings. It does not analyze persistence semantics.
 * JS/TS uses the gate's bundled parser; other languages use conservative input
 * syntax checks. Comments, labels and source examples do not execute. Unknown
 * calls carrying an exempt path are conservatively treated as consumers.
 */
interface ReaderEvidence {
  readonly inputPaths: readonly string[];
  readonly changelog: boolean;
  readonly loader: boolean;
  readonly dynamic: boolean;
}
const requireParser = createRequire(import.meta.url);
let parser: typeof TypeScript | undefined;

function protectedJsonText(text: string): boolean {
  return (
    text.includes("approved-scope") ||
    text.includes("xbrief/") ||
    text.includes("presentation-ceiling")
  );
}

function changelogPath(text: string): boolean {
  return /(?:^|\/)CHANGELOG(?:\.md)?$/.test(text);
}

function approvedScopeModule(specifier: string): boolean {
  return (
    /(?:^|\/)scope-provenance(?:\/|$)/.test(specifier) ||
    /^@deftai\/directive-core(?:\/scope-provenance)?$/.test(specifier)
  );
}

const DISPLAY_CALL = /^(?:log|warn|error|debug|info|print|printf|echo)$/;

/** Bounded fallback: mask strings/comments, then follow same-file assignments
 * into call arguments. This recognizes ordinary Python open(path) without
 * executing source or mistaking quoted code examples for calls. */
function fallbackReaderEvidence(content: string): ReaderEvidence {
  const values = new Map<string, string>();
  const executable = content.replace(
    /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|(?:#|\/\/)[^\n]*/g,
    (token) => {
      if (/^(?:#|\/\/|\/\*)/.test(token)) return token.replace(/[^\n]/g, " ");
      const width = token.startsWith('"""') || token.startsWith("'''") ? 3 : 1;
      const key = `__ceiling_literal_${values.size}`;
      values.set(key, token.slice(width, -width));
      // Keep Python r/b/u/f prefixes separate from the masked literal token.
      return ` ${key} `;
    },
  );
  const bindings = new Map<string, string[]>();
  for (const match of executable.matchAll(/\b([A-Za-z_]\w*)\s*=(?!=)([^\n;]+)/g)) {
    const name = match[1] ?? "";
    bindings.set(name, [...(bindings.get(name) ?? []), match[2] ?? ""]);
  }
  const resolveInputs = (text: string, seen = new Set<string>()): string[] => {
    const paths: string[] = [];
    for (const match of text.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      const name = match[0];
      if (seen.has(name)) continue;
      seen.add(name);
      const value = values.get(name);
      if (value !== undefined) paths.push(value);
      for (const binding of bindings.get(name) ?? []) paths.push(...resolveInputs(binding, seen));
    }
    return paths;
  };
  const inputPaths = new Set<string>();
  for (const match of executable.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1] ?? "";
    // A Python signature is not a call. Nested executable default expressions
    // and body calls are still visited by subsequent matches.
    if (/\b(?:def|class)\s+$/.test(executable.slice(0, match.index))) continue;
    if (DISPLAY_CALL.test(name) || /^(?:if|while|for|switch|return|def|class)$/.test(name))
      continue;
    const start = match.index + match[0].length;
    let end = start;
    let depth = 1;
    while (end < executable.length && depth > 0) {
      if (executable[end] === "(") depth++;
      if (executable[end] === ")") depth--;
      end++;
    }
    for (const path of resolveInputs(executable.slice(start, end - 1))) inputPaths.add(path);
  }
  return {
    inputPaths: [...inputPaths],
    changelog: [...inputPaths].some(changelogPath),
    loader: false,
    dynamic: executable
      .split(/[\n;]/)
      .some(
        (expression) =>
          /\+|\$\{|\b(?:join|resolve)\s*\(/.test(expression) &&
          resolveInputs(expression).some(protectedJsonText),
      ),
  };
}

function readerEvidence(path: string, content: string): ReaderEvidence {
  const empty: ReaderEvidence = { inputPaths: [], changelog: false, loader: false, dynamic: false };
  if (/\.(?:md|mdx|txt|rst|json|lock|csv|svg|css)$/i.test(path)) return empty;
  if (/\.html?$/i.test(path))
    content = [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
      .map((match) => match[1] ?? "")
      .join("\n");
  if (!/\.(?:[cm]?[jt]sx?|html?)$/i.test(path)) return fallbackReaderEvidence(content);
  // Lazy: importing core or evaluating an unarmed ceiling never loads TypeScript.
  parser ??= requireParser("typescript") as typeof TypeScript;
  const ts = parser;
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const inputPaths = new Set<string>();
  const bindings = new Set<string>();
  const namespaces = new Set<string>();
  const variables = new Map<string, TypeScript.Expression[]>();
  const recordValue = (name: string, value: TypeScript.Expression): void => {
    variables.set(name, [...(variables.get(name) ?? []), value]);
  };
  const registerBinding = (name: TypeScript.BindingName): void => {
    if (ts.isIdentifier(name)) namespaces.add(name.text);
    else if (ts.isObjectBindingPattern(name))
      for (const element of name.elements) {
        const original = element.propertyName?.getText(source) ?? element.name.getText(source);
        if (!ts.isIdentifier(element.name)) continue;
        if (LOADER_NAMES.some((loader) => loader === original)) bindings.add(element.name.text);
        if (original === "scopeProvenance") namespaces.add(element.name.text);
      }
  };
  const collect = (node: TypeScript.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      approvedScopeModule(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named))
        for (const element of named.elements) {
          const original = element.propertyName?.text ?? element.name.text;
          if (LOADER_NAMES.some((loader) => loader === original)) bindings.add(element.name.text);
          if (original === "scopeProvenance") namespaces.add(element.name.text);
        }
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
      if (clause?.name) namespaces.add(clause.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) recordValue(node.name.text, node.initializer);
      const init = node.initializer;
      if (
        ts.isCallExpression(init) &&
        init.expression.getText(source) === "require" &&
        init.arguments.some((arg) => ts.isStringLiteralLike(arg) && approvedScopeModule(arg.text))
      )
        registerBinding(node.name);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      recordValue(node.left.text, node.right);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const contains = (
    node: TypeScript.Node,
    predicate: (value: string) => boolean,
    seen = new Set<string>(),
  ): boolean => {
    if (ts.isStringLiteralLike(node)) return predicate(node.text);
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      // Retain every possible same-file value; a later write cannot erase an
      // earlier protected read. This is conservative syntax, not control flow.
      for (const value of variables.get(node.text) ?? []) {
        if (contains(value, predicate, seen)) return true;
      }
    }
    let hit = false;
    ts.forEachChild(node, (child) => {
      if (contains(child, predicate, seen)) hit = true;
    });
    return hit;
  };
  let loader = false;
  let dynamic = false;
  const collectInput = (node: TypeScript.Node): void => {
    contains(node, (value) => {
      inputPaths.add(value);
      return false;
    });
  };
  const visit = (node: TypeScript.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      collectInput(node.moduleSpecifier);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : "";
      if (!DISPLAY_CALL.test(name)) node.arguments?.forEach(collectInput);
      if (ts.isIdentifier(expression) && bindings.has(expression.text)) loader = true;
      if (
        ts.isPropertyAccessExpression(expression) &&
        LOADER_NAMES.some((known) => known === name)
      ) {
        let root: TypeScript.Expression = expression.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && namespaces.has(root.text)) loader = true;
      }
      if (/^(?:join|resolve)$/.test(name) && contains(node, protectedJsonText)) dynamic = true;
    }
    if (
      (ts.isTemplateExpression(node) ||
        (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
      contains(node, protectedJsonText)
    )
      dynamic = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    inputPaths: [...inputPaths],
    changelog: [...inputPaths].some(changelogPath),
    loader,
    dynamic,
  };
}

function standingNonGateHits(
  snapshot: PresentationCeilingSnapshot,
  predicate: (evidence: ReaderEvidence) => boolean,
): string[] {
  const hits = new Set<string>();
  for (const contents of [
    snapshot.standingFileContents,
    snapshot.baseFileContents ?? new Map<string, string>(),
  ]) {
    for (const [rawPath, content] of contents) {
      const path = normalizeRepoRelPath(rawPath);
      if (!isGateToolingPath(path) && predicate(readerEvidence(path, content))) hits.add(path);
    }
  }
  return [...hits];
}

function changelogHasProductionReader(snapshot: PresentationCeilingSnapshot): boolean {
  return standingNonGateHits(snapshot, (evidence) => evidence.changelog).length > 0;
}

function jsonExemptionPulled(
  relPath: string,
  snapshot: PresentationCeilingSnapshot,
): PresentationCeilingFinding | null {
  const posix = normalizeRepoRelPath(relPath);
  const loaderHits = isApprovedScopeRecordPath(posix)
    ? standingNonGateHits(snapshot, (evidence) => evidence.loader)
    : [];
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
  const refHits = standingNonGateHits(snapshot, (evidence) =>
    evidence.inputPaths.some(
      (text) =>
        text === posix ||
        text.endsWith(`/${posix}`) ||
        (posix.startsWith(APPROVED_SCOPE_PREFIX) && text.startsWith(APPROVED_SCOPE_PREFIX)),
    ),
  );
  if (refHits.length > 0) {
    return {
      kind: "json-exemption-referenced",
      path: posix,
      detail: `non-gate reference to ${posix} from ${refHits.join(", ")}`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  const dynamicHits = standingNonGateHits(snapshot, (evidence) => evidence.dynamic);
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
  const addedRestrictions = snapshot.headArtifacts
    .filter((art) => !baseMap.has(normalizeRepoRelPath(art.path)))
    .map((art) => ({ ...art, extensionAmendment: null }));
  const headAddsRestriction = addedRestrictions.length > 0;
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
    const headArt = headMap.get(basePath);
    if (headArt !== undefined) {
      const baseAllowed = effectivePresentationExts([{ ...baseArt, extensionAmendment: null }]);
      const headAllowed = effectivePresentationExts([{ ...headArt, extensionAmendment: null }]);
      if ([...headAllowed].some((ext) => !baseAllowed.has(ext))) {
        findings.push({
          kind: "ceiling-weaken",
          path: basePath,
          detail: "head allowlist weakens a merge-base presentation restriction",
          remediation: WEAKEN_REMEDIATION,
        });
      }
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

  // Head-only additions can narrow built-ins; only baseline stamps grant extras.
  const effectiveExts = effectivePresentationExts([
    ...snapshot.baseArtifacts,
    ...addedRestrictions,
  ]);
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

type Collection<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function gitOutput(
  projectRoot: string,
  args: readonly string[],
  allowNoMatch = false,
): Collection<string> {
  const result = git(args, projectRoot);
  if (!result.ok) return result;
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) {
    return { ok: false, message: `git ${args[0]} failed (exit ${String(result.status)})` };
  }
  return { ok: true, value: result.stdout };
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean).map(normalizeRepoRelPath);
}

function changedFilesVsBase(projectRoot: string, baseline: string): Collection<string[]> {
  const names = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "--no-renames", "-z", baseline, "HEAD", "--"],
    ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    const result = gitOutput(projectRoot, args);
    if (!result.ok) return result;
    for (const path of paths(result.value)) names.add(path);
  }
  return { ok: true, value: [...names] };
}

function isCeilingCandidatePath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  return (
    posix === PRESENTATION_CEILING_ARTIFACT_REL ||
    posix.endsWith("/presentation-ceiling.json") ||
    /^xbrief\/(?:active|pending|proposed)\/.*\.xbrief\.json$/.test(posix)
  );
}

/** Git grep distinguishes no matches (1) from a failed read (2+). */
function grepPaths(
  projectRoot: string,
  ref: string | null,
  patterns: readonly string[],
): Collection<string[]> {
  const args = ["grep", "-I", "-l", "-z", "-F"];
  for (const pattern of patterns) args.push("-e", pattern);
  if (ref !== null) args.push(ref);
  args.push("--");
  const result = gitOutput(projectRoot, args, true);
  if (!result.ok) return result;
  const prefix = ref === null ? "" : `${ref}:`;
  return {
    ok: true,
    value: paths(result.value).map((path) =>
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path,
    ),
  };
}

function readContents(
  projectRoot: string,
  ref: string | null,
  names: readonly string[],
): Collection<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const path of names) {
    if (ref !== null) {
      const result = gitOutput(projectRoot, ["show", `${ref}:${path}`]);
      if (!result.ok) return { ok: false, message: `${path}: ${result.message}` };
      contents.set(path, result.value);
    } else {
      try {
        contents.set(path, readFileSync(join(projectRoot, path), "utf8"));
      } catch (error) {
        // A tracked deletion is expected; every other read error fails closed.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { ok: false, message: `cannot read ${path}: ${String(error)}` };
      }
    }
  }
  return { ok: true, value: contents };
}

function parseArtifacts(
  contents: ReadonlyMap<string, string>,
): Collection<PresentationCeilingArtifact[]> {
  const artifacts: PresentationCeilingArtifact[] = [];
  for (const [path, text] of contents) {
    if (!isCeilingCandidatePath(path)) continue;
    try {
      const payload: unknown = JSON.parse(text);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, message: `invalid ceiling candidate object: ${path}` };
      }
      const artifact = parseCeilingPayload(payload, path);
      if (artifact !== null) artifacts.push(artifact);
    } catch {
      return { ok: false, message: `invalid ceiling candidate JSON: ${path}` };
    }
  }
  return { ok: true, value: artifacts };
}

function loadBaseRoots(
  contents: ReadonlyMap<string, string>,
): Collection<{ testRoots: readonly string[]; fixtureRoots: readonly string[] }> {
  const text = contents.get(".deft/test-boundary.policy.json");
  if (text === undefined)
    return {
      ok: true,
      value: { testRoots: DEFAULT_TEST_ROOTS, fixtureRoots: DEFAULT_FIXTURE_ROOTS },
    };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, message: "invalid baseline test-boundary policy object" };
    const policy = parsed as Record<string, unknown>;
    for (const name of ["testRoots", "fixtureRoots"]) {
      const value = policy[name];
      if (
        value !== undefined &&
        (!Array.isArray(value) || value.some((root) => typeof root !== "string"))
      )
        return { ok: false, message: `invalid baseline test-boundary ${name}` };
    }
    return {
      ok: true,
      value: {
        testRoots: (policy.testRoots as string[] | undefined) ?? DEFAULT_TEST_ROOTS,
        fixtureRoots: (policy.fixtureRoots as string[] | undefined) ?? DEFAULT_FIXTURE_ROOTS,
      },
    };
  } catch {
    return { ok: false, message: "invalid baseline test-boundary policy JSON" };
  }
}

/** All baseline authority and readers use the one resolved merge-base commit. */
export function evaluatePresentationCeiling(
  projectRoot: string,
  options: PresentationCeilingOptions = {},
): PresentationCeilingResult {
  if (options.snapshot !== undefined)
    return evaluatePresentationCeilingFromSnapshot(options.snapshot);
  const root = resolve(projectRoot);
  const inside = gitOutput(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return configResult(`${GATE_ID}: ${inside.message}`);
  const ref =
    options.baseRef ?? process.env.DEFT_BASE_REF ?? resolvePresentationCeilingBaseRef(root);
  if (ref === null) return configResult(`${GATE_ID}: no merge-base ref; pass --base-ref`);
  const mergeBase = gitOutput(root, ["merge-base", "--", ref, "HEAD"]);
  if (!mergeBase.ok || !mergeBase.value.trim())
    return configResult(`${GATE_ID}: cannot resolve merge-base for ${ref}`);
  const baseline = mergeBase.value.trim();
  const changed = changedFilesVsBase(root, baseline);
  if (!changed.ok) return configResult(`${GATE_ID}: ${changed.message}`);
  const tree = gitOutput(root, ["ls-tree", "-r", "--name-only", "-z", baseline]);
  if (!tree.ok) return configResult(`${GATE_ID}: ${tree.message}`);
  const baseTree = paths(tree.value);
  const baseHits = grepPaths(root, baseline, [
    PRESENTATION_CEILING_PLAN_KEY,
    PRESENTATION_CEILING_SCHEMA,
    "changeClass",
  ]);
  const headHits = grepPaths(root, null, [
    PRESENTATION_CEILING_PLAN_KEY,
    PRESENTATION_CEILING_SCHEMA,
    "changeClass",
  ]);
  if (!baseHits.ok) return configResult(`${GATE_ID}: ${baseHits.message}`);
  if (!headHits.ok) return configResult(`${GATE_ID}: ${headHits.message}`);
  const baseNames = new Set(baseHits.value.filter(isCeilingCandidatePath));
  for (const path of baseTree) if (path.endsWith("/presentation-ceiling.json")) baseNames.add(path);
  const baseContents = readContents(root, baseline, [...baseNames]);
  const headNames = [
    ...new Set([...baseNames, ...headHits.value, ...changed.value].filter(isCeilingCandidatePath)),
  ];
  const headContents = readContents(root, null, headNames);
  if (!baseContents.ok) return configResult(`${GATE_ID}: ${baseContents.message}`);
  if (!headContents.ok) return configResult(`${GATE_ID}: ${headContents.message}`);
  const baseArtifacts = parseArtifacts(baseContents.value);
  const headArtifacts = parseArtifacts(headContents.value);
  if (!baseArtifacts.ok) return configResult(`${GATE_ID}: ${baseArtifacts.message}`);
  if (!headArtifacts.ok) return configResult(`${GATE_ID}: ${headArtifacts.message}`);
  const snapshot: PresentationCeilingSnapshot = {
    changedFiles: changed.value,
    baseArtifacts: baseArtifacts.value,
    headArtifacts: headArtifacts.value,
    baseActiveXbriefPath: null,
    baseActiveXbriefPaths: baseArtifacts.value
      .map((artifact) => artifact.path)
      .filter((path) => path.startsWith("xbrief/active/")),
    headFileContents: headContents.value,
    standingFileContents: new Map(),
    baseTestRoots: DEFAULT_TEST_ROOTS,
    baseFixtureRoots: DEFAULT_FIXTURE_ROOTS,
    defaultTestRoots: DEFAULT_TEST_ROOTS,
    defaultFixtureRoots: DEFAULT_FIXTURE_ROOTS,
  };
  if (baseArtifacts.value.length === 0 && headArtifacts.value.length === 0)
    return evaluatePresentationCeilingFromSnapshot(snapshot);

  const patterns = [
    "approved-scope",
    "scope-provenance",
    "@deftai/directive-core",
    ...LOADER_NAMES,
    "CHANGELOG",
    "presentation-ceiling",
    "xbrief/",
  ];
  const baseReaders = grepPaths(root, baseline, patterns);
  const headReaders = grepPaths(root, null, patterns);
  if (!baseReaders.ok) return configResult(`${GATE_ID}: ${baseReaders.message}`);
  if (!headReaders.ok) return configResult(`${GATE_ID}: ${headReaders.message}`);
  // Raw grep cannot see decoded JS/TS literals (for example "\\x43HANGELOG.md").
  // Parse every tracked script candidate, including unchanged readers.
  const scriptPath = (path: string) => /\.(?:[cm]?[jt]sx?|html?)$/i.test(path);
  const liveTree = gitOutput(root, ["ls-files", "-z"]);
  if (!liveTree.ok) return configResult(`${GATE_ID}: ${liveTree.message}`);
  const policyPath = ".deft/test-boundary.policy.json";
  const baselineFiles = readContents(root, baseline, [
    ...new Set([
      ...baseReaders.value,
      ...baseTree.filter(scriptPath),
      ...(baseTree.includes(policyPath) ? [policyPath] : []),
    ]),
  ]);
  const liveFiles = readContents(root, null, [
    ...new Set([
      ...headReaders.value,
      ...paths(liveTree.value).filter(scriptPath),
      ...changed.value,
    ]),
  ]);
  if (!baselineFiles.ok) return configResult(`${GATE_ID}: ${baselineFiles.message}`);
  if (!liveFiles.ok) return configResult(`${GATE_ID}: ${liveFiles.message}`);
  const roots = loadBaseRoots(baselineFiles.value);
  if (!roots.ok) return configResult(`${GATE_ID}: ${roots.message}`);
  return evaluatePresentationCeilingFromSnapshot({
    ...snapshot,
    baseFileContents: baselineFiles.value,
    standingFileContents: liveFiles.value,
    baseTestRoots: roots.value.testRoots,
    baseFixtureRoots: roots.value.fixtureRoots,
  });
}
