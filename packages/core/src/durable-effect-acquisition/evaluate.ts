/**
 * verify:durable-effect-acquisition (#5080).
 *
 * Armed presentation ceiling: refuse or pass citing the recomputed rule.
 * skipped / N/A is not an exit under an armed ceiling.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyAmendments, evaluateArming, loadCeilingFromMap } from "./ceiling.js";
import { classifyHtmlDocument, dedupeFacts } from "./html.js";
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
  PRESENTATION_CEILING_DIR_REL,
  type PresentationCeiling,
  VERIFIER_PATHS,
} from "./types.js";

export type EvaluateOptions = {
  readonly projectRoot?: string;
  readonly originRef?: string;
  readonly quiet?: boolean;
  readonly changedFiles?: readonly string[];
  readonly mergeBase?: string;
  readonly readAtBase?: (relPath: string) => string | null;
  readonly readAtHead?: (relPath: string) => string | null;
  readonly presentationFiles?: readonly string[];
};

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
  const origin = originRef !== undefined && originRef.length > 0 ? originRef : "origin/master";
  const mb = runGit(projectRoot, ["merge-base", "HEAD", origin]);
  if (mb === null || mb.length === 0)
    return { error: `could not compute merge-base with ${origin}` };
  return mb;
}

function defaultChangedFiles(projectRoot: string, mergeBase: string): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    for (const line of raw.split("\n")) {
      const t = posix(line);
      if (t.length > 0) out.add(t);
    }
  };
  const diff = runGit(projectRoot, ["diff", "--name-only", `${mergeBase}...HEAD`]);
  if (diff !== null) add(diff);
  const vsHead = runGit(projectRoot, ["diff", "--name-only", "HEAD"]);
  if (vsHead !== null) add(vsHead);
  const staged = runGit(projectRoot, ["diff", "--name-only", "--cached"]);
  if (staged !== null) add(staged);
  const untracked = runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked !== null) add(untracked);
  return [...out];
}

function gitShow(projectRoot: string, ref: string, rel: string): string | null {
  return runGit(projectRoot, ["show", `${ref}:${rel}`]);
}

function listPresentation(
  projectRoot: string,
  mergeBase: string,
  extra: readonly string[],
): string[] {
  const out = new Set<string>(extra.filter(isInClassPath).map(posix));
  const baseTree = runGit(projectRoot, ["ls-tree", "-r", "--name-only", mergeBase]);
  if (baseTree !== null) {
    for (const line of baseTree.split("\n")) {
      if (isInClassPath(line)) out.add(posix(line));
    }
  }
  const headTree = runGit(projectRoot, ["ls-files"]);
  if (headTree !== null) {
    for (const line of headTree.split("\n")) {
      if (isInClassPath(line)) out.add(posix(line));
    }
  }
  return [...out];
}

function listCeilingRels(
  projectRoot: string,
  mergeBase: string,
  changed: readonly string[],
): string[] {
  const rels = new Set<string>([PRESENTATION_CEILING_ARTIFACT_REL]);
  for (const c of changed) {
    const p = posix(c);
    if (p.startsWith(`${PRESENTATION_CEILING_DIR_REL}/`) && p.endsWith(".json")) rels.add(p);
  }
  const baseTree = runGit(projectRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    mergeBase,
    PRESENTATION_CEILING_DIR_REL,
  ]);
  if (baseTree !== null) {
    for (const line of baseTree.split("\n")) {
      if (line.endsWith(".json")) rels.add(posix(line));
    }
  }
  try {
    const dir = join(projectRoot, PRESENTATION_CEILING_DIR_REL);
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json")) rels.add(`${PRESENTATION_CEILING_DIR_REL}/${name}`);
    }
  } catch {
    /* optional dir */
  }
  return [...rels];
}

function loadMap(
  rels: readonly string[],
  read: (rel: string) => string | null,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const rel of rels) map.set(rel, read(rel));
  return map;
}

function factIds(facts: readonly AcquisitionFact[]): Set<string> {
  return new Set(facts.map((f) => f.id));
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
  if (typeof mb !== "string") return config(mb.error);
  const changed = (options.changedFiles ?? defaultChangedFiles(projectRoot, mb)).map(posix);
  const readBase =
    options.readAtBase ?? ((rel: string): string | null => gitShow(projectRoot, mb, rel));
  const readHead =
    options.readAtHead ??
    ((rel: string): string | null => {
      const live = runGit(projectRoot, ["show", `HEAD:${rel}`]);
      if (live !== null) return live;
      try {
        return execFileSync("git", ["-C", projectRoot, "show", `:${rel}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        try {
          return readFileSync(join(projectRoot, rel), "utf8");
        } catch {
          return null;
        }
      }
    });

  const ceilingRels = listCeilingRels(projectRoot, mb, changed);
  const baseCeil = loadCeilingFromMap(loadMap(ceilingRels, readBase));
  if (!baseCeil.ok)
    return fail(
      `verify:durable-effect-acquisition: merge-base ceiling unreadable (${baseCeil.detail})`,
    );
  const headCeil = loadCeilingFromMap(loadMap(ceilingRels, readHead));
  if (!headCeil.ok)
    return fail(`verify:durable-effect-acquisition: head ceiling unreadable (${headCeil.detail})`);
  const arming = evaluateArming(baseCeil.ceiling, headCeil.ceiling, baseCeil.rel ?? headCeil.rel);
  if (!arming.armed) {
    return ok(
      "verify:durable-effect-acquisition: off-ceiling — no presentation restriction at merge-base or add-only/tightening head.",
      quiet,
    );
  }
  if (arming.samePrAllowlistEdit) {
    return fail(
      "verify:durable-effect-acquisition: same-PR rewrite of the presentation-ceiling allowlists refuses.",
    );
  }

  const verifierChanged = changed.filter(isVerifierPath);
  const verifierExisted = verifierChanged.some((rel) => readBase(rel) !== null);
  if (verifierExisted) {
    return fail(
      "verify:durable-effect-acquisition: same-PR rewrite of the durable-effect verifier refuses.",
    );
  }

  const amendments = emptyAmendments(arming.base);
  const tsLoad = loadProjectTypeScript(projectRoot);
  const ctx: JsxContext | null = tsLoad.ok
    ? {
        ts: tsLoad.ts,
        admittedOrigins: amendments.origins,
        admittedPackages: amendments.packages,
        admittedPaths: amendments.paths,
      }
    : null;

  const presentation = options.presentationFiles ?? listPresentation(projectRoot, mb, changed);
  for (const rel of presentation) {
    for (const reader of [readBase, readHead]) {
      const src = reader(rel);
      if (src === null) continue;
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
    const headClass = classifyFile(rel, headSrc, ctx, amendments.origins);
    if (!headClass.ok) {
      return fail(`verify:durable-effect-acquisition: ${rel}: ${headClass.detail}`, [
        { id: `parse:${rel}`, rule: headClass.rule, detail: headClass.detail },
      ]);
    }
    const baseSrc = readBase(rel);
    let baseIds = new Set<string>();
    if (baseSrc !== null) {
      const baseClass = classifyFile(rel, baseSrc, ctx, amendments.origins);
      if (!baseClass.ok) {
        return fail(`verify:durable-effect-acquisition: merge-base ${rel}: ${baseClass.detail}`);
      }
      baseIds = factIds(baseClass.facts);
    }
    for (const fact of headClass.facts) {
      if (baseIds.has(fact.id)) continue;
      findings.push({ ...fact, id: `${rel}:${fact.id}` });
    }
  }

  const unique = dedupeFacts(findings);
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
