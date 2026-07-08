import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/**
 * Layered AGENTS.md budget policy (#645 / #2372).
 *
 * The per-region line counts are the hard ratchet seeded at current size: any
 * growth past those values fails, reductions are always allowed, and increases
 * are reviewed diffs. The optional absolute target is a deterministic
 * north-star for the always-on context surface, enforceable by callers that pass
 * the release-gate flag.
 */
export interface AgentsMdBudget {
  readonly managedMaxLines: number;
  readonly unmanagedMaxLines: number;
  readonly absoluteTarget: AgentsMdAbsoluteTarget | null;
}

/**
 * Absolute always-on context target layered below the ratchet (#2372).
 *
 * `maxBytes` is the enforceable ceiling when callers pass the `--enforce-target`
 * flag. `approxTokens` is display-only: bytes are the deterministic unit, while
 * tokens vary by model/tokenizer.
 */
export interface AgentsMdAbsoluteTarget {
  readonly maxBytes: number;
  readonly approxTokens: number | null;
  readonly includeSkillFrontmatter: boolean;
}

export type AgentsMdBudgetSource = "typed" | "unset" | "default-on-error";

export interface AgentsMdBudgetResult {
  readonly budget: AgentsMdBudget | null;
  readonly source: AgentsMdBudgetSource;
  readonly error: string | null;
}

function pythonTypeName(value: unknown): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (typeof value === "object") return "dict";
  return typeof value;
}

function pythonRepr(value: unknown): string {
  if (value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function readNonNegativeInteger(
  block: Record<string, unknown>,
  key: string,
): { value: number | null; error: string | null } {
  if (!(key in block)) {
    return { value: null, error: `plan.policy.agentsMdBudget.${key} is required` };
  }
  const raw = block[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      value: null,
      error: `plan.policy.agentsMdBudget.${key} must be a non-negative integer; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw, error: null };
}

function readOptionalNonNegativeInteger(
  block: Record<string, unknown>,
  key: string,
  path: string,
): { value: number | null; error: string | null } {
  if (!(key in block)) {
    return { value: null, error: null };
  }
  const raw = block[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      value: null,
      error: `${path}.${key} must be a non-negative integer; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw, error: null };
}

function readOptionalBoolean(
  block: Record<string, unknown>,
  key: string,
  path: string,
  defaultValue: boolean,
): { value: boolean; error: string | null } {
  if (!(key in block)) {
    return { value: defaultValue, error: null };
  }
  const raw = block[key];
  if (typeof raw !== "boolean") {
    return {
      value: defaultValue,
      error: `${path}.${key} must be a bool; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw, error: null };
}

function readAbsoluteTarget(block: Record<string, unknown>): {
  value: AgentsMdAbsoluteTarget | null;
  error: string | null;
} {
  const path = "plan.policy.agentsMdBudget.absoluteTarget";
  if (!("absoluteTarget" in block)) {
    return { value: null, error: null };
  }

  const raw = block.absoluteTarget;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      value: null,
      error: `${path} must be an object with maxBytes; got ${pythonTypeName(raw)}`,
    };
  }

  const targetBlock = raw as Record<string, unknown>;
  const maxBytes = readOptionalNonNegativeInteger(targetBlock, "maxBytes", path);
  if (maxBytes.error !== null) {
    return { value: null, error: maxBytes.error };
  }
  if (maxBytes.value === null) {
    return { value: null, error: `${path}.maxBytes is required` };
  }

  const approxTokens = readOptionalNonNegativeInteger(targetBlock, "approxTokens", path);
  if (approxTokens.error !== null) {
    return { value: null, error: approxTokens.error };
  }

  const includeSkillFrontmatter = readOptionalBoolean(
    targetBlock,
    "includeSkillFrontmatter",
    path,
    true,
  );
  if (includeSkillFrontmatter.error !== null) {
    return { value: null, error: includeSkillFrontmatter.error };
  }

  return {
    value: {
      maxBytes: maxBytes.value,
      approxTokens: approxTokens.value,
      includeSkillFrontmatter: includeSkillFrontmatter.value,
    },
    error: null,
  };
}

/** Resolve plan.policy.agentsMdBudget from PROJECT-DEFINITION (#645). */
export function resolveAgentsMdBudget(projectRoot: string): AgentsMdBudgetResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { budget: null, source: "default-on-error", error: err };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      budget: null,
      source: "default-on-error",
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }

  const policyBlock = readPlanPolicy(plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("agentsMdBudget" in policyBlock)
  ) {
    return { budget: null, source: "unset", error: null };
  }

  const rawBudget = (policyBlock as Record<string, unknown>).agentsMdBudget;
  if (typeof rawBudget !== "object" || rawBudget === null || Array.isArray(rawBudget)) {
    return {
      budget: null,
      source: "default-on-error",
      error: `plan.policy.agentsMdBudget must be an object with managedMaxLines and unmanagedMaxLines; got ${pythonTypeName(rawBudget)}`,
    };
  }

  const block = rawBudget as Record<string, unknown>;
  const managed = readNonNegativeInteger(block, "managedMaxLines");
  if (managed.error !== null) {
    return { budget: null, source: "default-on-error", error: managed.error };
  }
  const unmanaged = readNonNegativeInteger(block, "unmanagedMaxLines");
  if (unmanaged.error !== null) {
    return { budget: null, source: "default-on-error", error: unmanaged.error };
  }
  const absoluteTarget = readAbsoluteTarget(block);
  if (absoluteTarget.error !== null) {
    return { budget: null, source: "default-on-error", error: absoluteTarget.error };
  }

  return {
    budget: {
      managedMaxLines: managed.value as number,
      unmanagedMaxLines: unmanaged.value as number,
      absoluteTarget: absoluteTarget.value,
    },
    source: "typed",
    error: null,
  };
}
