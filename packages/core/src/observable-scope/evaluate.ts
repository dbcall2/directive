/**
 * verify:observable-scope (#4495).
 *
 * Opt-in, base-pinned surfaces policy. Computed merge-base baseline.
 * One check, one remediation. Three-state 0/1/2.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDefaultBaseRef } from "../evaluator-surface/evaluate.js";
import { matchAny, normalizePath } from "../orchestration/pathspec.js";
import { diffArtifacts, unlistedDeltas } from "./diff.js";
import { buildArtifact, extractSurface, isMarkupPath } from "./extract.js";
import { observableScopeRecordRel, parseObservableScopeRecord } from "./mint.js";
import {
  OBSERVABLE_SCOPE_DIR,
  OBSERVABLE_SCOPE_REMEDIATION,
  OBSERVABLE_UI_POLICY_REL,
  OBSERVABLE_UI_POLICY_SCHEMA,
  type ObservableUiPolicy,
} from "./types.js";

export type OutputStream = "stdout" | "stderr" | "none";

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
}

export interface EvaluateOptions {
  readonly projectRoot?: string;
  /** Origin-default override used to *compute* merge-base. Not a contract baselineRef. */
  readonly originRef?: string;
  readonly staged?: boolean;
  readonly quiet?: boolean;
  readonly changedFiles?: readonly string[];
  readonly policyTextAtBase?: string | null;
  readonly recordTextsAtBase?: ReadonlyMap<string, string>;
  readonly readAtBase?: (relPath: string) => string | null;
  readonly readAtHead?: (relPath: string) => string | null;
  readonly mergeBase?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function resolveMergeBase(
  projectRoot: string,
  originRef?: string,
): string | { error: string } {
  let base = originRef;
  if (base === undefined || base.length === 0) {
    const resolved = resolveDefaultBaseRef(projectRoot);
    if (typeof resolved !== "string") return resolved;
    base = resolved;
  }
  const mb = runGit(projectRoot, ["merge-base", "HEAD", base]);
  if (mb === null || mb.length === 0) {
    return { error: `could not compute merge-base of HEAD and ${base}` };
  }
  return mb;
}

function gitNameOnlyDiff(projectRoot: string, args: string[]): string[] | { error: string } {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(normalizePath);
  } catch (err: unknown) {
    return { error: String(err) };
  }
}

export function parseObservableUiPolicy(raw: unknown): ObservableUiPolicy | { error: string } {
  if (!isRecord(raw)) return { error: "observable-ui policy must be a JSON object" };
  if (raw.schema !== OBSERVABLE_UI_POLICY_SCHEMA) {
    return { error: `policy.schema must be ${OBSERVABLE_UI_POLICY_SCHEMA}` };
  }
  if (
    !Array.isArray(raw.surfaces) ||
    raw.surfaces.some((s) => typeof s !== "string" || s.length === 0)
  ) {
    return { error: "policy.surfaces must be a non-empty-string array" };
  }
  if (raw.surfaces.length === 0) {
    return { error: "policy.surfaces must list at least one glob" };
  }
  return { schema: OBSERVABLE_UI_POLICY_SCHEMA, surfaces: raw.surfaces as string[] };
}

function gitShow(projectRoot: string, rev: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, "show", `${rev}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readHeadFile(projectRoot: string, relPath: string): string | null {
  const full = join(resolve(projectRoot), ...relPath.split("/"));
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

function fail(message: string): EvaluateResult {
  return { code: 1, message: `${message} ${OBSERVABLE_SCOPE_REMEDIATION}`, stream: "stderr" };
}

function config(message: string): EvaluateResult {
  return { code: 2, message: `verify:observable-scope: ${message}`, stream: "stderr" };
}

function ok(message: string, skipped = false, quiet = false): EvaluateResult {
  return {
    code: 0,
    message: quiet ? "" : message,
    stream: "stdout",
    skipped,
  };
}

function loadPolicyAtBase(
  options: EvaluateOptions,
  projectRoot: string,
  mergeBase: string,
): ObservableUiPolicy | { error: string } | null {
  let text: string | null;
  if (options.policyTextAtBase !== undefined) {
    text = options.policyTextAtBase;
  } else {
    const reader = options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase, rel));
    text = reader(OBSERVABLE_UI_POLICY_REL);
  }
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    return { error: `${OBSERVABLE_UI_POLICY_REL} is not valid JSON: ${String(err)}` };
  }
  return parseObservableUiPolicy(parsed);
}

function listBaseRecords(
  options: EvaluateOptions,
  projectRoot: string,
  mergeBase: string,
): Map<string, string> {
  if (options.recordTextsAtBase !== undefined) {
    return new Map(options.recordTextsAtBase);
  }
  const reader = options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase, rel));
  const names = runGit(projectRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    mergeBase,
    OBSERVABLE_SCOPE_DIR,
  ]);
  const out = new Map<string, string>();
  if (names === null || names.length === 0) {
    // Fall back to working-tree listing only for injected readers in tests.
    const dir = join(resolve(projectRoot), ...OBSERVABLE_SCOPE_DIR.split("/"));
    if (options.readAtBase !== undefined && existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const rel = `${OBSERVABLE_SCOPE_DIR}/${name}`;
        const text = reader(rel);
        if (text !== null) out.set(rel, text);
      }
    }
    return out;
  }
  for (const rel of names
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const text = reader(rel);
    if (text !== null) out.set(normalizePath(rel), text);
  }
  return out;
}

export function evaluateObservableScope(options: EvaluateOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? ".");
  let mergeBase = options.mergeBase;
  if (mergeBase === undefined || mergeBase.length === 0) {
    const resolved = resolveMergeBase(projectRoot, options.originRef);
    if (typeof resolved !== "string") {
      return config(resolved.error);
    }
    mergeBase = resolved;
  }

  let changed: string[];
  if (options.changedFiles !== undefined) {
    changed = options.changedFiles.map(normalizePath);
  } else if (options.staged === true) {
    const collected = gitNameOnlyDiff(projectRoot, ["--cached"]);
    if (!Array.isArray(collected)) return config(collected.error);
    changed = collected;
  } else {
    const collected = gitNameOnlyDiff(projectRoot, [mergeBase, "HEAD"]);
    if (!Array.isArray(collected)) return config(collected.error);
    changed = collected;
  }

  const policy = loadPolicyAtBase(options, projectRoot, mergeBase);
  if (policy !== null && "error" in policy) {
    return config(policy.error);
  }
  if (policy === null) {
    return ok(
      "verify:observable-scope: N/A — no base-pinned observable-ui surfaces policy " +
        `(${OBSERVABLE_UI_POLICY_REL}). This is not yet universal UI coverage; ` +
        "the verb is composed with an internal skip.",
      true,
      options.quiet === true,
    );
  }

  const matched = changed.filter((p) => matchAny(policy.surfaces, p));
  if (matched.length === 0) {
    return ok(
      "verify:observable-scope: N/A — changed paths are outside the base-pinned surfaces policy.",
      true,
      options.quiet === true,
    );
  }

  const recordRewrites = changed.filter(
    (p) => p === OBSERVABLE_UI_POLICY_REL || p.startsWith(`${OBSERVABLE_SCOPE_DIR}/`),
  );
  if (recordRewrites.some((p) => p.startsWith(`${OBSERVABLE_SCOPE_DIR}/`))) {
    return fail(
      "verify:observable-scope: same-PR rewrite of the observable-scope mint record is not a contract.",
    );
  }

  const baseRecords = listBaseRecords(options, projectRoot, mergeBase);
  if (baseRecords.size === 0) {
    return fail(
      "verify:observable-scope: matched UI surfaces changed without a merge-base observable-scope mint record.",
    );
  }

  const parsedRecords = [];
  for (const [rel, text] of baseRecords) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err: unknown) {
      return config(`${rel} is not valid JSON: ${String(err)}`);
    }
    const parsed = parseObservableScopeRecord(raw);
    if ("error" in parsed) {
      return config(`${rel}: ${parsed.error}`);
    }
    parsedRecords.push(parsed);
  }

  const uiPaths = matched.filter((p) => isMarkupPath(p) || matchAny(policy.surfaces, p));
  const readBase = options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase, rel));
  const readHead = options.readAtHead ?? ((rel: string) => readHeadFile(projectRoot, rel));

  const baseSurfaces = [];
  const headSurfaces = [];
  for (const path of uiPaths) {
    const baseText = readBase(path) ?? "";
    const headText = readHead(path) ?? "";
    baseSurfaces.push(extractSurface(path, baseText));
    headSurfaces.push(extractSurface(path, headText));
  }

  const deltas = diffArtifacts(buildArtifact(baseSurfaces), buildArtifact(headSurfaces));
  const allowed = parsedRecords.flatMap((r) => r.allowedChanges);
  const leftover = unlistedDeltas(deltas, allowed);
  if (leftover.length > 0) {
    const listed = leftover
      .slice(0, 8)
      .map((d) => `${d.path} ${d.op} ${d.kind} ${d.name}`)
      .join("; ");
    return fail(
      `verify:observable-scope: unlisted structure delta versus merge-base oracle (${listed}).`,
    );
  }

  return ok(
    `verify:observable-scope: minted allowedChanges cover the committed-markup oracle ` +
      `(${uiPaths.length} surface(s), ${parsedRecords.length} mint record(s)).`,
    false,
    options.quiet === true,
  );
}

export { observableScopeRecordRel };
