import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSpecArtifactPath } from "../layout/resolve.js";
import { generatedSourcePath } from "../spec-authority/constants.js";
import {
  greenfieldOverviewNonEmpty,
  resolveExportNarratives,
} from "../spec-authority/narratives.js";
import { resolveSpecAuthority } from "../spec-authority/resolver.js";
import { buildPrdBanner, PRD_GENERATED_SENTINEL, PRD_NARRATIVE_KEY_ORDER } from "./constants.js";
import { validateSpec } from "./spec-validate.js";

type JsonObject = Record<string, unknown>;

export interface RenderPrdOptions {
  readonly force?: boolean;
}

function isDeftGenerated(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const fh = readFileSync(path, "utf8");
    const head = fh.length > 4096 ? fh.slice(0, 4096) : fh;
    return head.includes(PRD_GENERATED_SENTINEL);
  } catch {
    return false;
  }
}

function writePrd(
  title: string,
  narratives: Record<string, unknown>,
  sourcePath: string,
  outputPath: string,
  force: boolean,
): void {
  if (!force && !isDeftGenerated(outputPath)) {
    process.stderr.write(
      `Error: refusing to overwrite non-generated PRD at ${outputPath}. ` +
        `This file lacks the "${PRD_GENERATED_SENTINEL}" banner -- it was likely hand-authored. ` +
        "Re-run with --force to overwrite, or point --output at a different file (#539).\n",
    );
    process.exit(2);
  }

  if (Object.keys(narratives).length === 0) {
    process.stderr.write(`Warning: no narratives found in ${sourcePath}\n`);
  }

  const lines: string[] = [
    buildPrdBanner(sourcePath),
    `# ${title} -- Product Requirements Document\n`,
  ];
  const renderedKeys = new Set<string>();
  for (const key of PRD_NARRATIVE_KEY_ORDER) {
    if (key in narratives) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(narratives[key])}\n`);
      renderedKeys.add(key);
    }
  }
  for (const key of Object.keys(narratives).sort()) {
    if (!renderedKeys.has(key)) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(narratives[key])}\n`);
    }
  }
  lines.push(
    "---\n" +
      `*This document is auto-generated from \`${generatedSourcePath(sourcePath)}\` ` +
      "via `task prd:render`. Do not edit directly.*\n",
  );

  writeFileSync(outputPath, lines.join("\n"), "utf8");
  process.stdout.write(`PRD.md written to ${outputPath}\n`);
}

function loadTitleAndNarratives(sourcePath: string): {
  title: string;
  narratives: Record<string, unknown>;
} {
  const data = JSON.parse(readFileSync(sourcePath, "utf8")) as JsonObject;
  const plan = (data.plan ?? {}) as JsonObject;
  const narratives =
    typeof plan.narratives === "object" &&
    plan.narratives !== null &&
    !Array.isArray(plan.narratives)
      ? (plan.narratives as Record<string, unknown>)
      : {};
  return { title: String(plan.title ?? "Project"), narratives };
}

/** Read an explicit specification artifact and write PRD.md. */
export function renderPrd(
  specPath: string,
  outputPath: string,
  options: RenderPrdOptions = {},
): void {
  if (!existsSync(specPath)) {
    process.stderr.write(`Error: specification file not found: ${specPath}\n`);
    process.exit(1);
  }
  const { title, narratives } = loadTitleAndNarratives(specPath);
  writePrd(title, narratives, specPath, outputPath, options.force ?? false);
}

/** Resolve full-spec or greenfield project authority and write a stakeholder-safe PRD. */
export function renderProjectPrd(
  projectRoot: string,
  outputPath: string,
  options: RenderPrdOptions = {},
): void {
  const root = resolve(projectRoot);
  const authority = resolveSpecAuthority(root);
  if (!authority) {
    try {
      const compatibilitySpecPath = resolveSpecArtifactPath(root);
      if (existsSync(compatibilitySpecPath)) {
        renderPrd(compatibilitySpecPath, outputPath, options);
        return;
      }
    } catch {
      // The stable error below covers projects without a resolvable lifecycle layout.
    }
    process.stderr.write(
      "Error: xbrief/PROJECT-DEFINITION.xbrief.json not found; PRD authority is unavailable.\n",
    );
    process.exit(1);
  }
  if (authority.kind === "full-spec" && authority.specPath) {
    const [ok, message] = validateSpec(authority.specPath);
    if (!ok) {
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  } else if (!greenfieldOverviewNonEmpty(authority)) {
    process.stderr.write(
      "Error: PROJECT-DEFINITION.xbrief.json Overview narrative is empty; cannot render PRD.\n",
    );
    process.exit(1);
  }
  const { title } = loadTitleAndNarratives(authority.sourcePath);
  writePrd(
    title,
    resolveExportNarratives(authority),
    authority.sourcePath,
    outputPath,
    options.force ?? false,
  );
}

export interface PrdCliArgs {
  readonly spec?: string;
  readonly projectRoot?: string;
  readonly output?: string;
  readonly force?: boolean;
}

/** CLI entry (mirrors ``scripts/prd_render.main``). */
export function main(args: PrdCliArgs = {}): void {
  const outputPath = args.output ?? "PRD.md";
  const options = { force: args.force ?? false };
  if (args.spec !== undefined) {
    renderPrd(args.spec, outputPath, options);
  } else if (args.projectRoot !== undefined) {
    renderProjectPrd(args.projectRoot, outputPath, options);
  } else {
    renderPrd("vbrief/specification.vbrief.json", outputPath, options);
  }
}

export function parsePrdArgv(argv: readonly string[]): PrdCliArgs {
  const out: { spec?: string; output?: string; force?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--force") out.force = true;
    else if (arg === "--spec") out.spec = argv[++i];
    else if (arg === "--output") out.output = argv[++i];
  }
  return out;
}
