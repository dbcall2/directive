/**
 * verify:durable-effect-acquisition (#5080).
 *
 * Armed presentation ceiling: refuse or pass citing the recomputed rule.
 * skipped / N/A is not an exit under an armed ceiling.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePresentationCeilingBaseRef } from "../presentation-ceiling/evaluate.js";
import {
  allowlistsDiffer,
  combineCeilings,
  emptyAmendments,
  isCeilingCandidatePath,
  loadCeilingFromMap,
} from "./ceiling.js";
import { classifyHtmlDocument } from "./html.js";
import {
  classifyHandlerText,
  classifyTsxSource,
  type JsxContext,
  loadProjectTypeScript,
} from "./jsx.js";
import {
  type AcquisitionFact,
  type ClassifyResult,
  DURABLE_EFFECT_REMEDIATION,
  type EvaluateResult,
  IN_CLASS_EXT,
  type OutputStream,
  PRESENTATION_CEILING_ARTIFACT_REL,
  type PresentationCeiling,
  VERIFIER_PATHS,
} from "./types.js";

export type EvaluateOptions = {
  readonly projectRoot?: string;
  readonly originRef?: string;
  readonly quiet?: boolean;
  readonly changedFiles?: readonly string[];
  readonly mergeBase?: string;
  readonly readAtBase?: (relPath: string) => SnapshotRead;
  readonly readAtHead?: (relPath: string) => SnapshotRead;
  readonly ceilingFiles?: readonly string[];
  readonly presentationFiles?: readonly string[];
};

type ReadError = { readonly error: string };
export type SnapshotRead = string | null | ReadError;
function runGit(projectRoot: string, args: readonly string[]): string | ReadError {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (err) {
    return { error: `git ${args[0]} failed: ${String(err)}` };
  }
}
function readError(value: SnapshotRead): value is ReadError {
  return value !== null && typeof value !== "string";
}

function posix(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInClassPath(rel: string): boolean {
  return IN_CLASS_EXT.test(posix(rel));
}

function isVerifierPath(rel: string): boolean {
  const p = posix(rel);
  return VERIFIER_PATHS.some((v) => (v.endsWith("/") ? p.startsWith(v) : p === v));
}

function ok(message: string, quiet: boolean): EvaluateResult {
  return { code: 0, message: quiet ? "" : message, stream: quiet ? "none" : "stdout" };
}

function fail(message: string, findings?: readonly AcquisitionFact[]): EvaluateResult {
  return {
    code: 1,
    message: `${message}\n  Recovery: ${DURABLE_EFFECT_REMEDIATION}`,
    stream: "stderr",
    findings,
  };
}

function config(message: string): EvaluateResult {
  return { code: 2, message: `verify:durable-effect-acquisition: ${message}`, stream: "stderr" };
}

function resolveMergeBase(
  projectRoot: string,
  originRef?: string,
  injected?: string,
): string | { error: string } {
  if (injected !== undefined && injected.length > 0) return injected;
  const origin =
    originRef !== undefined && originRef.length > 0
      ? originRef
      : resolvePresentationCeilingBaseRef(projectRoot);
  if (origin === null || origin.length === 0)
    return {
      error:
        "could not compute merge-base: no resolvable base ref (DEFT_BASE_REF, GITHUB_BASE_REF, origin/master, origin/main, master, main)",
    };
  const mb = runGit(projectRoot, ["merge-base", "HEAD", origin]);
  if (typeof mb !== "string" || mb.trim().length === 0)
    return {
      error: `could not compute merge-base with ${origin}${typeof mb === "string" ? "" : `: ${mb.error}`}`,
    };
  return mb.trim();
}

function loadLiveHeadCeilings(
  projectRoot: string,
  extra?: readonly string[],
):
  | { ok: true; records: ReadonlyMap<string, PresentationCeiling> }
  | { ok: false; result: EvaluateResult } {
  const tracked = runGit(projectRoot, ["ls-files", "-z"]);
  const untracked = runGit(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const split = (value: string | ReadError): string[] =>
    typeof value === "string" ? value.split("\0").filter(Boolean).map(posix) : [];
  const rels = [
    ...new Set([
      PRESENTATION_CEILING_ARTIFACT_REL,
      ...split(tracked),
      ...split(untracked),
      ...(extra ?? []),
    ]),
  ].filter(isCeilingCandidatePath);
  const map = loadMap(rels, (rel) => readLivePresentationSource(projectRoot, rel));
  if ("error" in map) return { ok: false, result: config(map.error) };
  const loaded = loadCeilingFromMap(map);
  if (!loaded.ok)
    return {
      ok: false,
      result: fail(`verify:durable-effect-acquisition: head ceiling unreadable (${loaded.detail})`),
    };
  return { ok: true, records: loaded.records };
}

/** Live snapshot only: deletion is absence, never an index/HEAD fallback. */
export function readLivePresentationSource(projectRoot: string, rel: string): SnapshotRead {
  try {
    return readFileSync(join(projectRoot, rel), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { error: `read ${rel} failed: ${String(err)}` };
  }
}
function listSnapshot(
  projectRoot: string,
  mb: string,
): { base: string[]; head: string[]; changed: string[] } | ReadError {
  const base = runGit(projectRoot, ["ls-tree", "-r", "--name-only", "-z", mb]);
  if (typeof base !== "string") return base;
  const tracked = runGit(projectRoot, ["ls-files", "-z"]);
  if (typeof tracked !== "string") return tracked;
  const untracked = runGit(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (typeof untracked !== "string") return untracked;
  const changed = runGit(projectRoot, ["diff", "--no-renames", "--name-only", "-z", mb, "--"]);
  if (typeof changed !== "string") return changed;
  const split = (s: string): string[] => s.split("\0").filter(Boolean).map(posix);
  return {
    base: split(base),
    head: [...new Set([...split(tracked), ...split(untracked)])],
    changed: [...new Set([...split(changed), ...split(untracked)])],
  };
}
function loadMap(
  rels: readonly string[],
  read: (rel: string) => SnapshotRead,
): Map<string, string | null> | ReadError {
  const map = new Map<string, string | null>();
  for (const rel of rels) {
    const value = read(rel);
    if (readError(value)) return value;
    map.set(rel, value);
  }
  return map;
}
function counts(facts: readonly AcquisitionFact[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const fact of facts) out.set(fact.id, (out.get(fact.id) ?? 0) + 1);
  return out;
}

function classifyFile(
  rel: string,
  source: string,
  ctx: JsxContext | null,
  admittedOrigins: readonly string[],
): ClassifyResult {
  if (rel.toLowerCase().endsWith(".html")) {
    if (ctx === null) {
      const hasHandler = /\son[a-z]+\s*=/i.test(source) || /<script[\s>]/i.test(source);
      if (hasHandler) {
        return {
          ok: false,
          rule: "item-9",
          detail: "pure-HTML consumer without TypeScript refuses inline-script or handler changes",
        };
      }
      return classifyHtmlDocument(source, { admittedOrigins, jsFacts: () => [] });
    }
    return classifyHtmlDocument(source, {
      admittedOrigins,
      jsFacts: (text, via) =>
        [...classifyHandlerText(text, ctx)].map((f) => ({ ...f, id: `${via}:${f.id}` })),
    });
  }
  if (ctx === null) {
    return {
      ok: false,
      rule: "item-9",
      detail: "parser unavailable: TypeScript required for .jsx/.tsx",
    };
  }
  return classifyTsxSource(rel, source, ctx);
}

export function evaluateDurableEffectAcquisition(options: EvaluateOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const quiet = options.quiet === true;
  const mb = resolveMergeBase(projectRoot, options.originRef, options.mergeBase);
  if (typeof mb !== "string") {
    const live = loadLiveHeadCeilings(projectRoot, options.ceilingFiles);
    if (!live.ok) return live.result;
    return config(mb.error);
  }
  const injected =
    options.readAtBase !== undefined &&
    options.readAtHead !== undefined &&
    options.changedFiles !== undefined;
  const snapshot = injected
    ? { base: [] as string[], head: [] as string[], changed: [...(options.changedFiles ?? [])] }
    : listSnapshot(projectRoot, mb);
  if ("error" in snapshot) return config(snapshot.error);
  const changed = (options.changedFiles ?? snapshot.changed).map(posix);
  const baseNames = new Set(snapshot.base);
  const readBase =
    options.readAtBase ??
    ((rel: string): SnapshotRead =>
      baseNames.has(rel) ? runGit(projectRoot, ["show", `${mb}:${rel}`]) : null);
  const readHead =
    options.readAtHead ??
    ((rel: string): SnapshotRead => readLivePresentationSource(projectRoot, rel));
  const ceilingRels = [
    ...new Set([
      PRESENTATION_CEILING_ARTIFACT_REL,
      ...snapshot.base,
      ...snapshot.head,
      ...changed,
      ...(options.ceilingFiles ?? []),
    ]),
  ].filter(isCeilingCandidatePath);
  const baseMap = loadMap(ceilingRels, readBase);
  if ("error" in baseMap) return config(baseMap.error);
  const headMap = loadMap(ceilingRels, readHead);
  if ("error" in headMap) return config(headMap.error);
  const baseCeil = loadCeilingFromMap(baseMap);
  if (!baseCeil.ok)
    return fail(
      `verify:durable-effect-acquisition: merge-base ceiling unreadable (${baseCeil.detail})`,
    );
  const headCeil = loadCeilingFromMap(headMap);
  if (!headCeil.ok)
    return fail(`verify:durable-effect-acquisition: head ceiling unreadable (${headCeil.detail})`);
  if (baseCeil.records.size === 0 && headCeil.records.size === 0)
    return ok(
      "verify:durable-effect-acquisition: off-ceiling — no presentation restriction at merge-base or head.",
      quiet,
    );
  for (const [rel, base] of baseCeil.records) {
    const head = headCeil.records.get(rel);
    if (head && allowlistsDiffer(base, head))
      return fail(
        `verify:durable-effect-acquisition: same-PR rewrite of presentation-ceiling allowlists refuses (${rel}).`,
      );
  }
  // Head-only ceilings restrict immediately; their grants have no base authority.
  const effective = combineCeilings([
    ...baseCeil.records.values(),
    ...[...headCeil.records]
      .filter(([rel]) => !baseCeil.records.has(rel))
      .map(([, c]) => ({ ...c, humanApproval: undefined })),
  ]);
  const verifierChanged = changed.filter(isVerifierPath);
  let verifierExisted = false;
  for (const rel of verifierChanged) {
    const value = readBase(rel);
    if (readError(value)) return config(value.error);
    if (value !== null) verifierExisted = true;
  }
  if (verifierExisted) {
    return fail(
      "verify:durable-effect-acquisition: same-PR rewrite of the durable-effect verifier refuses.",
    );
  }

  const amendments = emptyAmendments(effective);
  const tsLoad = loadProjectTypeScript(projectRoot);
  const ctx: JsxContext | null = tsLoad.ok
    ? {
        ts: tsLoad.ts,
        admittedOrigins: amendments.origins,
        admittedPackages: amendments.packages,
        admittedPaths: amendments.paths,
        admittedGlobals: amendments.globals,
      }
    : null;

  const presentation =
    options.presentationFiles ??
    [...new Set([...snapshot.base, ...snapshot.head, ...changed])].filter(isInClassPath);
  for (const rel of presentation) {
    for (const reader of [readBase, readHead]) {
      const src = reader(rel);
      if (src === null) continue;
      if (readError(src)) return config(src.error);
      const classified = classifyFile(rel, src, ctx, amendments.origins);
      if (!classified.ok) {
        return fail(`verify:durable-effect-acquisition: ${rel}: ${classified.detail}`, [
          { id: `parse:${rel}`, rule: classified.rule, detail: classified.detail },
        ]);
      }
      const baseHit = classified.facts.find((f) => f.rule === "item-6");
      if (baseHit !== undefined) {
        return fail(
          `verify:durable-effect-acquisition: non-sentinel document base in ${rel} (${baseHit.detail})`,
          [baseHit],
        );
      }
    }
  }

  const findings: AcquisitionFact[] = [];
  for (const rel of changed.filter(isInClassPath)) {
    const headSrc = readHead(rel);
    if (headSrc === null) continue;
    if (readError(headSrc)) return config(headSrc.error);
    if (amendments.paths.includes(rel)) continue;
    const headClass = classifyFile(rel, headSrc, ctx, amendments.origins);
    if (!headClass.ok) {
      return fail(`verify:durable-effect-acquisition: ${rel}: ${headClass.detail}`, [
        { id: `parse:${rel}`, rule: headClass.rule, detail: headClass.detail },
      ]);
    }
    const baseSrc = readBase(rel);
    if (readError(baseSrc)) return config(baseSrc.error);
    let baseIds = new Map<string, number>();
    if (baseSrc !== null) {
      const baseClass = classifyFile(rel, baseSrc, ctx, amendments.origins);
      if (!baseClass.ok) {
        return fail(`verify:durable-effect-acquisition: merge-base ${rel}: ${baseClass.detail}`);
      }
      baseIds = counts(baseClass.facts);
    }
    for (const fact of headClass.facts) {
      const remaining = baseIds.get(fact.id) ?? 0;
      if (remaining > 0) {
        baseIds.set(fact.id, remaining - 1);
        continue;
      }
      findings.push({ ...fact, id: `${rel}:${fact.id}` });
    }
  }

  const unique = findings;
  if (unique.length > 0) {
    const listed = unique.map((f) => f.id).join(", ");
    return fail(
      `verify:durable-effect-acquisition: in-class durable-effect acquisition under an armed presentation ceiling (${listed}).`,
      unique,
    );
  }
  return ok(
    `verify:durable-effect-acquisition: pass — recomputed rule on ${String(changed.filter(isInClassPath).length)} in-class file(s) under an armed presentation ceiling.`,
    quiet,
  );
}

export type { OutputStream, PresentationCeiling };
