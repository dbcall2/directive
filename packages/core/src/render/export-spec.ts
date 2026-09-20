import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import {
  greenfieldOverviewNonEmpty,
  renderNarrativeSections,
  resolveExportNarratives,
} from "../spec-authority/narratives.js";
import { resolveSpecAuthority } from "../spec-authority/resolver.js";
import { type IncludeScopesMode, LEGACY_ARTIFACTS_NARRATIVE_KEY } from "./constants.js";
import { buildScopeOutlookSection } from "./scope-outlook.js";
import {
  normalizeIncludeScopesMode,
  renderImplementationPlanLines,
  resolveItemDepthCap,
  tryParseIncludeScopesMode,
  tryParseItemDepthCap,
  tryParseOnOffFlag,
} from "./spec-render.js";
import { validateSpec } from "./spec-validate.js";
import { stripTrailingWhitespace } from "./text-utils.js";

type JsonObject = Record<string, unknown>;

export type ExportAudience = "stakeholder" | "internal";

export interface ExportSpecOptions {
  /** Trusted containment root for the output write (#3953). Defaults to cwd. */
  readonly projectRoot?: string;
  readonly outPath?: string;
  readonly audience?: ExportAudience;
  /**
   * Lifecycle scope aggregation (#1566). Default `off` (compact).
   * `current` = pending+active; `all` / true = include completed archive.
   */
  readonly includeScopes?: boolean | IncludeScopesMode;
  readonly includeLegacyArtifacts?: boolean;
  readonly proposedLimit?: number;
  /**
   * Nested plan.items depth cap (#4511). Default 3 (phase, subphase, task).
   * Nested-on is the no-flag path; unknown tokens fail closed.
   */
  readonly itemDepthCap?: number | string;
}

export type ExportSpecResult = readonly [boolean, string];

interface ExportScopePolicy {
  readonly render: boolean;
  readonly includeProposed: boolean;
  readonly includeCurrent: boolean;
  readonly includeCompleted: boolean;
}

function resolveExportScopePolicy(
  audience: ExportAudience,
  includeScopes: ExportSpecOptions["includeScopes"],
): ExportScopePolicy {
  const includeProposed = audience === "internal";
  if (includeScopes === undefined) {
    return {
      render: includeProposed,
      includeProposed,
      includeCurrent: false,
      includeCompleted: false,
    };
  }
  const mode = normalizeIncludeScopesMode(includeScopes);
  if (mode === "off") {
    return {
      render: false,
      includeProposed: false,
      includeCurrent: false,
      includeCompleted: false,
    };
  }
  return {
    render: true,
    includeProposed,
    includeCurrent: true,
    includeCompleted: mode === "all",
  };
}

function loadPlan(path: string): JsonObject | null {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const plan = doc.plan;
    if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      return plan as JsonObject;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function loadPlanTitle(path: string, fallback: string): string {
  const plan = loadPlan(path);
  if (plan) return String(plan.title ?? fallback);
  return fallback;
}

function loadPlanItems(path: string): unknown {
  const plan = loadPlan(path);
  return plan?.items ?? [];
}

function filterLegacyArtifacts(
  narratives: Record<string, string>,
  includeLegacyArtifacts: boolean,
): Record<string, string> {
  if (includeLegacyArtifacts) return narratives;
  const filtered: Record<string, string> = {};
  for (const [key, val] of Object.entries(narratives)) {
    if (key === LEGACY_ARTIFACTS_NARRATIVE_KEY) continue;
    filtered[key] = val;
  }
  return filtered;
}

/** Unified spec export (#2013 / #1502). */
export function exportSpec(options: ExportSpecOptions = {}): ExportSpecResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outPath = options.outPath ?? join(projectRoot, "SPECIFICATION.md");
  const audience = options.audience ?? "stakeholder";
  const scopePolicy = resolveExportScopePolicy(audience, options.includeScopes);
  const includeLegacyArtifacts = options.includeLegacyArtifacts ?? false;
  const depthCap = resolveItemDepthCap(options.itemDepthCap);
  if (!depthCap.ok) return [false, depthCap.message];

  const authority = resolveSpecAuthority(projectRoot);
  if (!authority) {
    return [false, "✗ Missing xbrief/PROJECT-DEFINITION.xbrief.json — cannot export spec."];
  }

  if (authority.kind === "full-spec" && authority.specPath) {
    const [ok, msg] = validateSpec(authority.specPath);
    if (!ok) return [false, msg];
  } else if (!greenfieldOverviewNonEmpty(authority)) {
    return [
      false,
      "⚠ PROJECT-DEFINITION.xbrief.json Overview narrative is empty (D3). Populate Overview before export.",
    ];
  }

  const narratives = filterLegacyArtifacts(
    resolveExportNarratives(authority),
    includeLegacyArtifacts,
  );
  const title =
    authority.kind === "full-spec" && authority.specPath
      ? loadPlanTitle(authority.specPath, "Specification")
      : loadPlanTitle(authority.projectDefPath, "Specification");

  const planSource =
    authority.kind === "full-spec" && authority.specPath
      ? authority.specPath
      : authority.projectDefPath;
  const planItems = loadPlanItems(planSource);

  const lines: string[] = [
    authority.banner,
    `# ${title}\n`,
    ...renderNarrativeSections(narratives),
    ...renderImplementationPlanLines(planItems, depthCap.cap),
  ];

  if (scopePolicy.render) {
    const scopeLines = buildScopeOutlookSection(authority.vbriefDir, {
      includeProposed: scopePolicy.includeProposed,
      proposedLimit: options.proposedLimit,
      includeCurrent: scopePolicy.includeCurrent,
      includeCompleted: scopePolicy.includeCompleted,
    });
    if (scopeLines.length > 0) lines.push(...scopeLines);
  }

  try {
    containedWrite({
      root: projectRoot,
      target: outPath,
      data: stripTrailingWhitespace(lines.join("\n")),
      mode: "replace",
    });
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      return [false, err.message];
    }
    throw err;
  }
  return [true, `✓ Exported spec to ${outPath}`];
}

export function parseExportSpecArgv(argv: readonly string[]): {
  options: ExportSpecOptions;
  errors: string[];
} {
  const options: {
    projectRoot?: string;
    outPath?: string;
    audience?: ExportAudience;
    includeScopes?: boolean | IncludeScopesMode;
    includeLegacyArtifacts?: boolean;
    proposedLimit?: number;
    itemDepthCap?: number;
  } = {};
  const errors: string[] = [];
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--audience=stakeholder" || arg === "--audience=internal") {
      options.audience = arg.split("=")[1] as ExportAudience;
      continue;
    }
    if (arg.startsWith("--proposed-limit=")) {
      const n = Number(arg.split("=", 2)[1]);
      if (Number.isFinite(n) && n > 0) options.proposedLimit = n;
      continue;
    }
    if (arg === "--no-scopes") {
      options.includeScopes = "off";
      continue;
    }
    if (arg === "--include-scopes") {
      options.includeScopes = "all";
      continue;
    }
    if (arg.startsWith("--include-scopes=")) {
      const value = arg.split("=", 2)[1] ?? "";
      const parsed = tryParseIncludeScopesMode(value);
      if (parsed === undefined) {
        errors.push(
          `Invalid --include-scopes=${value} (expected off|current|all|active|on|true|1|yes|false|0|no)`,
        );
      } else {
        options.includeScopes = parsed;
      }
      continue;
    }
    if (arg === "--include-legacy-artifacts") {
      options.includeLegacyArtifacts = true;
      continue;
    }
    if (arg.startsWith("--include-legacy-artifacts=")) {
      const value = arg.split("=", 2)[1] ?? "";
      const parsed = tryParseOnOffFlag(value);
      if (parsed === undefined) {
        errors.push(
          `Invalid --include-legacy-artifacts=${value} (expected on|off|true|false|1|0|yes|no)`,
        );
      } else {
        options.includeLegacyArtifacts = parsed;
      }
      continue;
    }
    if (arg === "--item-depth") {
      errors.push("Missing --item-depth value (expected integer >= 1)");
      continue;
    }
    if (arg.startsWith("--item-depth=")) {
      const value = arg.split("=", 2)[1] ?? "";
      const parsed = tryParseItemDepthCap(value);
      if (parsed === undefined) {
        errors.push(`Invalid --item-depth=${value} (expected integer >= 1)`);
      } else {
        options.itemDepthCap = parsed;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }
    positional.push(arg);
  }

  if (positional[0]) options.projectRoot = positional[0];
  if (positional[1]) options.outPath = positional[1];

  return { options: options as ExportSpecOptions, errors };
}

export function exportSpecMain(argv: readonly string[]): number {
  const { options, errors } = parseExportSpecArgv(argv);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    return 2;
  }
  const [ok, msg] = exportSpec(options);
  console.log(msg);
  return ok ? 0 : 1;
}
