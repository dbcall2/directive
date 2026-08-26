/**
 * Done-gate toolchain preflight at session start (#3282).
 *
 * Verifies the framework done-gate's own toolchain (task binary, package
 * manager, node, optional CLI dist) up front so agents get a named cause +
 * remedy in one turn instead of reverse-engineering `directive check` failures.
 *
 * Never bootstraps tooling the PRODUCT does not need. Failures name cause and
 * remedy without embedding env values.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  allGatesCliDispatchable,
  GLOBAL_CLI_REMEDY,
  isCliNativeGate,
} from "../check/cli-native-gates.js";
import { isFrameworkRepoRoot, isFrameworkSourceContext } from "../check/context.js";
import {
  type CheckGateSpec,
  CONSUMER_CHECK_GATES,
  checkGateId,
  FRAMEWORK_CHECK_GATES,
} from "../check/gate-lists.js";
import { defaultWhich } from "../doctor/which.js";
import {
  type PackageManager,
  type PackageManagerResolutionSource,
  packageManagerSourceLabel,
  resolveProjectPackageManager,
} from "../resolution/package-manager.js";

/** Maintainer toolchain remains pnpm-based. Consumer tools are selected dynamically. */
export const TOOLCHAIN_PREFLIGHT_TOOLS = ["task", "pnpm", "node", "git"] as const;
export type ToolchainPreflightTool = "task" | PackageManager | "node" | "git";

export type ToolchainPreflightStatus = "ok" | "missing" | "degraded";

/** How a missing tool affects check dispatch (#3335). */
export type ToolchainPreflightImpact = "none" | "degraded";

export interface ToolchainPreflightFinding {
  readonly tool: ToolchainPreflightTool | "package_manager" | "cli_dist";
  readonly present: boolean;
  /** Machine-stable cause code (never embeds env values). */
  readonly cause: string | null;
  /** Operator/agent remedy command or instruction. */
  readonly remedy: string | null;
  /**
   * Missing-tool impact. `none` = present false but no install remedy and
   * check does not skip CLI-native gates (#3335).
   */
  readonly impact?: ToolchainPreflightImpact | null;
}

export interface ToolchainPreflightResult {
  readonly status: ToolchainPreflightStatus;
  readonly ok: boolean;
  /** True when missing tools would force check into degraded/skip mode. */
  readonly degraded: boolean;
  readonly findings: readonly ToolchainPreflightFinding[];
  /** Human lines for session:start stdout (named cause + remedy). */
  readonly lines: readonly string[];
  /**
   * Gate ids that check should skip when this preflight is degraded.
   * Product-ordering of remaining gates is owned by #3284.
   */
  readonly skipGateIds: readonly string[];
  /** Closed manager selected for this project, or null on strict selection failure. */
  readonly packageManager?: PackageManager | null;
  /** Selection provenance; maintainer source is deliberately fixed to pnpm. */
  readonly packageManagerSource?: PackageManagerResolutionSource | "maintainer" | null;
}

export interface ToolchainPreflightOptions {
  readonly projectRoot?: string;
  readonly frameworkRoot?: string;
  /** which(name) seam for tests. */
  readonly which?: (name: string) => string | null;
  /** existsSync seam for tests. */
  readonly exists?: (path: string) => boolean;
  /**
   * When true (default), also probe for a built CLI dist under frameworkRoot
   * (framework-source dogfood). Consumers without a local dist are fine when
   * a global `deft`/`directive` is on PATH.
   */
  readonly probeCliDist?: boolean;
  /** Active check composition. Defaults from consumer vs framework context. */
  readonly composedGates?: readonly CheckGateSpec[];
  /**
   * Consumer deposit (not framework source). When omitted, inferred from
   * frameworkRoot vs projectRoot (#3335 / #3324).
   */
  readonly consumerDeposit?: boolean;
  /** Environment map used for consumer package-manager precedence. */
  readonly env?: NodeJS.ProcessEnv;
}

const REMEDY: Record<ToolchainPreflightTool, string> = {
  task: "Install go-task: https://taskfile.dev/installation/ (e.g. winget install Task.Task / brew install go-task)",
  npm: "Install or repair Node 20+ (npm is bundled), then re-run the consumer check",
  pnpm: "Enable pnpm via corepack: corepack enable && corepack prepare pnpm@latest --activate",
  node: "Install Node 20+ (see .nvmrc)",
  git: "Install Git: https://git-scm.com/downloads",
};

const CAUSE: Record<ToolchainPreflightTool, string> = {
  task: "go-task binary not found on PATH",
  npm: "npm binary not found on PATH",
  pnpm: "pnpm binary not found on PATH",
  node: "node binary not found on PATH",
  git: "git binary not found on PATH",
};

/**
 * Gates that specifically need a package manager / built dist.
 * When task/node is missing, the orchestrator skips *all* scheduled gates
 * (dynamic from gate-lists), not this static list — avoids hardcode drift.
 */
export const PACKAGE_MANAGER_DEPENDENT_GATE_IDS: readonly string[] = [
  "toolchain:check",
  "toolchain:check-consumer",
  "ts:check-lane",
];

/** @deprecated use PACKAGE_MANAGER_DEPENDENT_GATE_IDS. */
export const PNPM_DEPENDENT_GATE_IDS = PACKAGE_MANAGER_DEPENDENT_GATE_IDS;

/** Sentinel skip id meaning "every gate in the active check composition". */
export const SKIP_ALL_GATES = "*";

function probeTool(
  tool: ToolchainPreflightTool,
  which: (name: string) => string | null,
  packageManager: PackageManager | null,
): ToolchainPreflightFinding {
  const present = which(tool) !== null;
  let remedy = REMEDY[tool];
  if (tool === "node" && packageManager === "npm") {
    remedy = "Install or repair Node 20+ (npm is bundled), then re-run the consumer check";
  } else if (tool === "node" && packageManager === "pnpm") {
    remedy = "Install Node 20+ (see .nvmrc); then enable pnpm with Corepack";
  }
  return {
    tool,
    present,
    cause: present ? null : CAUSE[tool],
    remedy: present ? null : remedy,
  };
}

function probeCliDist(
  frameworkRoot: string | undefined,
  which: (name: string) => string | null,
  exists: (path: string) => boolean,
): ToolchainPreflightFinding {
  const globalCli = which("deft") !== null || which("directive") !== null;
  if (globalCli) {
    return { tool: "cli_dist", present: true, cause: null, remedy: null };
  }
  if (frameworkRoot) {
    const distBin = join(frameworkRoot, "packages", "cli", "dist", "bin.js");
    if (exists(distBin)) {
      return { tool: "cli_dist", present: true, cause: null, remedy: null };
    }
    return {
      tool: "cli_dist",
      present: false,
      cause: "CLI dist missing and no global deft/directive on PATH",
      remedy: "Run `task build` (framework source) or `npm i -g @deftai/directive@latest`",
    };
  }
  return {
    tool: "cli_dist",
    present: false,
    cause: "no global deft/directive on PATH",
    remedy: "Install: npm i -g @deftai/directive@latest",
  };
}

function formatFindingLine(finding: ToolchainPreflightFinding): string {
  if (finding.present) {
    return `[deft preflight] ${finding.tool}: ok`;
  }
  if (finding.impact === "none") {
    const cause = finding.cause ?? "absent";
    const remedy = finding.remedy === null ? "" : `; remedy: ${finding.remedy}`;
    return `[deft preflight] ${finding.tool}: absent (impact: none) — ${cause}${remedy}`;
  }
  const cause = finding.cause ?? "missing";
  const remedy = finding.remedy ?? "install the tool";
  return `[deft preflight] ${finding.tool}: MISSING — cause: ${cause}; remedy: ${remedy}`;
}

function inferConsumerDeposit(options: ToolchainPreflightOptions): boolean {
  if (options.consumerDeposit !== undefined) return options.consumerDeposit;
  const project = options.projectRoot;
  if (project === undefined) return false;
  const framework = options.frameworkRoot ?? project;
  // session:start passes equal roots for both framework source and a consumer
  // deposit. Equal roots identify maintainer mode only when the tree has the
  // framework-source markers; otherwise this is the production consumer shape.
  if (resolve(framework) === resolve(project)) {
    return !isFrameworkRepoRoot(project);
  }
  return !isFrameworkSourceContext(framework, project);
}

/**
 * Run done-gate toolchain preflight. Read-only probe — never installs or builds.
 */
export function runToolchainPreflight(
  options: ToolchainPreflightOptions = {},
): ToolchainPreflightResult {
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? existsSync;
  const consumerDeposit = inferConsumerDeposit(options);
  const composed =
    options.composedGates ?? (consumerDeposit ? CONSUMER_CHECK_GATES : FRAMEWORK_CHECK_GATES);
  const allCli = allGatesCliDispatchable(composed);
  const findings: ToolchainPreflightFinding[] = [];
  let packageManager: PackageManager | null = "pnpm";
  let packageManagerSource: PackageManagerResolutionSource | "maintainer" | null = "maintainer";
  let packageManagerSelectionFailed = false;
  let selectedTools: readonly ToolchainPreflightTool[] = TOOLCHAIN_PREFLIGHT_TOOLS;

  if (consumerDeposit) {
    const resolution = resolveProjectPackageManager({
      projectRoot: options.projectRoot,
      env: options.env,
    });
    if (resolution.ok) {
      packageManager = resolution.packageManager;
      packageManagerSource = resolution.source;
      selectedTools = ["task", packageManager, "node", "git"];
    } else {
      packageManager = null;
      packageManagerSource = null;
      packageManagerSelectionFailed = true;
      selectedTools = ["task", "node", "git"];
      findings.push({
        tool: "package_manager",
        present: false,
        cause: resolution.message,
        remedy:
          "Set package.json#packageManager (or DEFT_PACKAGE_MANAGER) to a supported npm or pnpm value",
      });
    }
  }

  for (const tool of selectedTools) {
    findings.push(probeTool(tool, which, packageManager));
  }

  if (options.probeCliDist !== false) {
    findings.push(probeCliDist(options.frameworkRoot ?? options.projectRoot, which, exists));
  }

  const cliPresent = findings.some((f) => f.tool === "cli_dist" && f.present);
  const taskMissing = findings.some((f) => f.tool === "task" && !f.present);
  const nodeMissing = findings.some((f) => f.tool === "node" && !f.present);
  const packageManagerMissing =
    packageManagerSelectionFailed ||
    (packageManager !== null && findings.some((f) => f.tool === packageManager && !f.present));

  // #3335: in a deposit whose composed gates are all CLI-dispatchable, a
  // missing task binary is impact none — no install-go-task remedy.
  if (taskMissing && allCli) {
    const idx = findings.findIndex((f) => f.tool === "task");
    const prior = findings[idx];
    if (idx >= 0 && prior !== undefined) {
      findings[idx] = {
        ...prior,
        impact: "none",
        remedy: cliPresent || nodeMissing ? null : GLOBAL_CLI_REMEDY,
        cause: cliPresent
          ? "go-task absent; CLI-native gates dispatch via global deft/directive (#3335)"
          : "go-task absent and no global deft/directive CLI",
      };
    }
  }

  // Keep finding impact aligned with the skip calculation. Git is advisory in
  // this preflight, and a local CLI dist matters only when task is absent and
  // every composed gate must dispatch through the CLI.
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (finding === undefined || finding.present) continue;
    if (finding.tool === "git") {
      findings[index] = { ...finding, impact: "none" };
    } else if (finding.tool === "cli_dist") {
      findings[index] = {
        ...finding,
        impact: taskMissing && allCli && !cliPresent ? "degraded" : "none",
      };
    }
  }

  const missingCritical = findings.filter((f) => {
    if (f.present || f.impact === "none") return false;
    return (
      f.tool === "task" ||
      f.tool === "node" ||
      f.tool === "package_manager" ||
      f.tool === packageManager
    );
  });

  const skip = new Set<string>();
  if (nodeMissing) {
    skip.add(SKIP_ALL_GATES);
  } else if (taskMissing && !allCli) {
    if (!cliPresent) {
      skip.add(SKIP_ALL_GATES);
    } else {
      for (const spec of composed) {
        const id = checkGateId(spec);
        if (!isCliNativeGate(id)) skip.add(id);
      }
    }
  } else if (taskMissing && allCli && !cliPresent) {
    skip.add(SKIP_ALL_GATES);
  } else if (packageManagerMissing) {
    for (const id of PACKAGE_MANAGER_DEPENDENT_GATE_IDS) {
      skip.add(id);
    }
  }

  const degraded = missingCritical.length > 0 || (taskMissing && allCli && !cliPresent);
  const ok = !degraded;
  const status: ToolchainPreflightStatus = ok ? "ok" : "degraded";

  const lines: string[] = [];
  lines.push(`[deft preflight] toolchain status: ${status}`);
  if (
    consumerDeposit &&
    packageManager !== null &&
    packageManagerSource !== null &&
    packageManagerSource !== "maintainer"
  ) {
    lines.push(
      `[deft preflight] package manager: ${packageManager} (${packageManagerSourceLabel(packageManagerSource)})`,
    );
  }
  for (const finding of findings) {
    if (!finding.present) {
      lines.push(formatFindingLine(finding));
    }
  }
  if (ok) {
    lines.push(
      taskMissing && allCli
        ? `[deft preflight] done-gate toolchain ready (CLI dispatch; go-task not required; package manager: ${packageManager}) (#3335)`
        : `[deft preflight] done-gate toolchain ready (task, ${packageManager}, node)`,
    );
  } else {
    lines.push(
      "[deft preflight] degraded mode: directive check will skip toolchain-dependent gates " +
        "with a named skip report rather than bootstrapping product-unneeded tooling (#3282)",
    );
    if (skip.size > 0) {
      lines.push(
        `[deft preflight] gates subject to skip when degraded: ${[...skip].sort().join(", ")}`,
      );
    }
  }

  return {
    status,
    ok,
    degraded,
    findings,
    lines,
    skipGateIds: [...skip].sort(),
    packageManager,
    packageManagerSource,
  };
}

/** Serialize preflight for run-summary / ritual-state (no env values). */
export function toolchainPreflightToDict(
  result: ToolchainPreflightResult,
): Record<string, unknown> {
  return {
    status: result.status,
    ok: result.ok,
    degraded: result.degraded,
    package_manager: result.packageManager ?? null,
    package_manager_source: result.packageManagerSource ?? null,
    findings: result.findings.map((f) => ({
      tool: f.tool,
      present: f.present,
      cause: f.cause,
      remedy: f.remedy,
      ...(f.impact !== undefined ? { impact: f.impact } : {}),
    })),
    skip_gate_ids: [...result.skipGateIds],
  };
}
