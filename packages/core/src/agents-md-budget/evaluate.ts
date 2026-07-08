import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import { type AgentsMdAbsoluteTarget, resolveAgentsMdBudget } from "../policy/agents-md-budget.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** Result of verify:agents-md-budget evaluation; three-state exit contract. */
export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
}

export interface EvaluateOptions {
  readonly quiet?: boolean;
  readonly enforceTarget?: boolean;
}

/** Per-region line counts of an AGENTS.md file. */
export interface RegionCounts {
  readonly total: number;
  readonly managed: number;
  readonly unmanaged: number;
}

export interface AlwaysOnCounts {
  readonly bytes: number;
  readonly approxTokens: number;
  readonly agentsBytes: number;
  readonly skillFrontmatterBytes: number;
  readonly skillFrontmatterFiles: number;
}

const OPEN_MARKER_PREFIX = "<!-- deft:managed-section";

/**
 * Split AGENTS.md into managed / unmanaged line counts.
 *
 * Returns `{ counts }` on success, or `{ error }` when the managed markers are
 * malformed (exactly one marker present, or close-before-open). A file with no
 * markers at all is valid: the whole file counts as unmanaged.
 */
export function countRegions(text: string): { counts: RegionCounts } | { error: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Ignore the trailing empty element produced by a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;

  const openLine = lines.findIndex((l) => l.startsWith(OPEN_MARKER_PREFIX));
  const closeLine = lines.findIndex((l) => l.trim().startsWith(AGENTS_MANAGED_CLOSE));
  const openCount = lines.filter((l) => l.startsWith(OPEN_MARKER_PREFIX)).length;
  const closeCount = lines.filter((l) => l.trim().startsWith(AGENTS_MANAGED_CLOSE)).length;

  if (openLine === -1 && closeLine === -1) {
    return { counts: { total, managed: 0, unmanaged: total } };
  }
  // Malformed if a marker is missing, close precedes open, or either marker is
  // duplicated -- the contract promises exactly one open/close pair.
  if (
    openLine === -1 ||
    closeLine === -1 ||
    closeLine < openLine ||
    openCount > 1 ||
    closeCount > 1
  ) {
    return {
      error:
        "AGENTS.md managed-section markers are malformed " +
        `(open@${openLine === -1 ? "none" : openLine + 1}×${openCount}, ` +
        `close@${closeLine === -1 ? "none" : closeLine + 1}×${closeCount}); ` +
        "expected a single <!-- deft:managed-section ... --> ... " +
        "<!-- /deft:managed-section --> pair.",
    };
  }

  const managed = closeLine - openLine + 1;
  return { counts: { total, managed, unmanaged: total - managed } };
}

function formatRefusal(
  counts: RegionCounts,
  managedMax: number,
  unmanagedMax: number,
  projectRoot: string,
): string {
  const over: string[] = [];
  if (counts.managed > managedMax) {
    over.push(
      `   managed region:   ${counts.managed}/${managedMax} lines (OVER by ${counts.managed - managedMax})`,
    );
  }
  if (counts.unmanaged > unmanagedMax) {
    over.push(
      `   unmanaged region: ${counts.unmanaged}/${unmanagedMax} lines (OVER by ${counts.unmanaged - unmanagedMax})`,
    );
  }
  return (
    `❌ verify:agents-md-budget: AGENTS.md grew past its ratchet ` +
    `(project_root=${projectRoot}).\n` +
    `${over.join("\n")}\n` +
    "   AGENTS.md is a map, not a manual (#1882): push detail into a\n" +
    "   reference doc (main.md / a pack / docs/) and leave a pointer,\n" +
    "   rather than expanding AGENTS.md. See REFERENCES.md.\n" +
    "   If the growth is deliberate, raise the matching line in\n" +
    "   plan.policy.agentsMdBudget in PROJECT-DEFINITION (a reviewed diff). (#645)"
  );
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function approxTokensForBytes(bytes: number): number {
  return Math.ceil(bytes / 4.096);
}

function walkSkillFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSkillFiles(path, out);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(path);
    }
  }
}

function skillFilePaths(projectRoot: string): string[] {
  const paths: string[] = [];
  const rootSkill = join(projectRoot, "SKILL.md");
  try {
    if (existsSync(rootSkill) && statSync(rootSkill).isFile()) {
      paths.push(rootSkill);
    }
  } catch {
    // Optional skill metadata must not make the primary AGENTS.md gate flaky.
  }
  walkSkillFiles(join(projectRoot, "content", "skills"), paths);
  return paths.sort();
}

export function extractYamlFrontmatter(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let open = -1;
  let inHtmlComment = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (inHtmlComment) {
      if (trimmed.endsWith("-->")) {
        inHtmlComment = false;
      }
      continue;
    }
    if (trimmed === "---") {
      open = index;
      break;
    }
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.endsWith("-->")) {
        inHtmlComment = true;
      }
      continue;
    }
    if (trimmed !== "") {
      return null;
    }
  }
  if (open === -1) {
    return null;
  }

  const close = lines.findIndex((line, index) => index > open && line.trim() === "---");
  if (close === -1) {
    return null;
  }
  return lines.slice(open, close + 1).join("\n");
}

export function countAlwaysOnBytes(
  projectRoot: string,
  agentsText: string,
  target: AgentsMdAbsoluteTarget,
): AlwaysOnCounts {
  const agentsBytes = utf8Bytes(agentsText);
  let skillFrontmatterBytes = 0;
  let skillFrontmatterFiles = 0;

  if (target.includeSkillFrontmatter) {
    for (const path of skillFilePaths(projectRoot)) {
      let skillText: string;
      try {
        skillText = readFileSync(path, { encoding: "utf8" });
      } catch {
        continue;
      }
      const frontmatter = extractYamlFrontmatter(skillText);
      if (frontmatter === null) {
        continue;
      }
      skillFrontmatterBytes += utf8Bytes(frontmatter);
      skillFrontmatterFiles += 1;
    }
  }

  const bytes = agentsBytes + skillFrontmatterBytes;
  return {
    bytes,
    approxTokens: approxTokensForBytes(bytes),
    agentsBytes,
    skillFrontmatterBytes,
    skillFrontmatterFiles,
  };
}

function formatTarget(counts: AlwaysOnCounts, target: AgentsMdAbsoluteTarget): string {
  const tokenPart =
    target.approxTokens === null
      ? `~${counts.approxTokens} tok`
      : `~${counts.approxTokens}/${target.approxTokens} tok`;
  const skillPart = target.includeSkillFrontmatter
    ? `; skill frontmatter ${counts.skillFrontmatterBytes} bytes from ${counts.skillFrontmatterFiles} file(s)`
    : "; skill frontmatter excluded";
  return (
    `always-on ${counts.bytes}/${target.maxBytes} bytes (${tokenPart}; ` +
    `AGENTS.md ${counts.agentsBytes} bytes${skillPart})`
  );
}

function formatTargetRefusal(
  counts: AlwaysOnCounts,
  target: AgentsMdAbsoluteTarget,
  projectRoot: string,
): string {
  return (
    `ERROR verify:agents-md-budget: always-on surface exceeds its absolute target ` +
    `(project_root=${projectRoot}).\n` +
    `   ${formatTarget(counts, target)} (OVER by ${counts.bytes - target.maxBytes} bytes)\n` +
    "   Keep the line ratchet as the anti-inflation floor, then relocate rule\n" +
    "   bulk into lazy docs, packs, deterministic gates, or invoked skills so\n" +
    "   AGENTS.md plus injected skill frontmatter fit the configured target. (#2372)"
  );
}

function formatTargetAdvisory(counts: AlwaysOnCounts, target: AgentsMdAbsoluteTarget): string {
  return (
    `WARN verify:agents-md-budget: absolute target not yet met: ` +
    `${formatTarget(counts, target)} (OVER by ${counts.bytes - target.maxBytes} bytes). ` +
    "Default mode preserves the hard ratchet gate; pass --enforce-target when this " +
    "target becomes a release gate. (#2372)"
  );
}

/**
 * Pure evaluator for the layered AGENTS.md budget gate (#645 / #2372).
 *
 * The per-region line ratchet fails on growth. The optional absolute target
 * reports AGENTS.md plus injected skill frontmatter by default and fails only
 * when callers request target enforcement.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;
  const enforceTarget = options.enforceTarget ?? false;

  const budgetResult = resolveAgentsMdBudget(root);
  if (budgetResult.source === "default-on-error") {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: PROJECT-DEFINITION malformed: ${budgetResult.error}`,
      stream: "stderr",
    };
  }

  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: AGENTS.md not found at ${agentsPath}`,
      stream: "stderr",
    };
  }

  let text: string;
  try {
    text = readFileSync(agentsPath, { encoding: "utf8" });
  } catch (err: unknown) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: AGENTS.md at ${agentsPath} cannot be read: ${String(err)}`,
      stream: "stderr",
    };
  }

  const regionResult = countRegions(text);
  if ("error" in regionResult) {
    return {
      code: 2,
      message: `❌ verify:agents-md-budget: ${regionResult.error}`,
      stream: "stderr",
    };
  }
  const counts = regionResult.counts;

  if (budgetResult.source === "unset") {
    if (enforceTarget) {
      return {
        code: 2,
        message:
          "❌ verify:agents-md-budget: --enforce-target was requested, but " +
          "plan.policy.agentsMdBudget.absoluteTarget is not configured.",
        stream: "stderr",
      };
    }
    if (quiet) {
      return { code: 0, message: "", stream: "none" };
    }
    return {
      code: 0,
      message:
        "⚠ verify:agents-md-budget: no plan.policy.agentsMdBudget configured " +
        `(managed=${counts.managed}, unmanaged=${counts.unmanaged} lines).\n` +
        "  Seed a ratchet at current size to freeze growth (#645): set\n" +
        "  plan.policy.agentsMdBudget.{managedMaxLines,unmanagedMaxLines} in " +
        "PROJECT-DEFINITION.",
      stream: "stderr",
    };
  }

  /* v8 ignore start -- defensive: source "typed" always carries a non-null budget. */
  if (budgetResult.budget === null) {
    return {
      code: 2,
      message: "❌ verify:agents-md-budget: unexpected null budget for typed source",
      stream: "stderr",
    };
  }
  /* v8 ignore stop */
  const budget = budgetResult.budget;
  const overManaged = counts.managed > budget.managedMaxLines;
  const overUnmanaged = counts.unmanaged > budget.unmanagedMaxLines;
  const absoluteTarget = budget.absoluteTarget;
  if (enforceTarget && absoluteTarget === null) {
    return {
      code: 2,
      message:
        "❌ verify:agents-md-budget: --enforce-target was requested, but " +
        "plan.policy.agentsMdBudget.absoluteTarget is not configured.",
      stream: "stderr",
    };
  }
  const alwaysOnCounts =
    absoluteTarget === null ? null : countAlwaysOnBytes(root, text, absoluteTarget);
  const overAbsoluteTarget =
    alwaysOnCounts !== null &&
    absoluteTarget !== null &&
    alwaysOnCounts.bytes > absoluteTarget.maxBytes;

  if (!overManaged && !overUnmanaged) {
    if (enforceTarget && overAbsoluteTarget && alwaysOnCounts !== null && absoluteTarget !== null) {
      return {
        code: 1,
        message: formatTargetRefusal(alwaysOnCounts, absoluteTarget, root),
        stream: "stderr",
      };
    }
    if (quiet) {
      return { code: 0, message: "", stream: "none" };
    }
    if (overAbsoluteTarget && alwaysOnCounts !== null && absoluteTarget !== null) {
      return {
        code: 0,
        message:
          `OK verify:agents-md-budget: managed ${counts.managed}/${budget.managedMaxLines}, ` +
          `unmanaged ${counts.unmanaged}/${budget.unmanagedMaxLines} lines (within ratchet).\n` +
          formatTargetAdvisory(alwaysOnCounts, absoluteTarget),
        stream: "stderr",
      };
    }
    const targetText =
      alwaysOnCounts !== null && absoluteTarget !== null
        ? `; ${formatTarget(alwaysOnCounts, absoluteTarget)} (within absolute target)`
        : "";
    return {
      code: 0,
      message:
        `✓ verify:agents-md-budget: managed ${counts.managed}/${budget.managedMaxLines}, ` +
        `unmanaged ${counts.unmanaged}/${budget.unmanagedMaxLines} lines (within ratchet)${targetText}.`,
      stream: "stdout",
    };
  }

  return {
    code: 1,
    message: formatRefusal(counts, budget.managedMaxLines, budget.unmanagedMaxLines, root),
    stream: "stderr",
  };
}
