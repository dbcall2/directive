/**
 * Typed #1019 policy path for destructive-gh-verb / default-branch-push gates.
 *
 * Writer shape mirrors policy:allow-direct-commits (#746 / #747): confirm-gated
 * allow, audited set, env-var remains an override at the gate — not bootstrap.
 */
import { existsSync } from "node:fs";
import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import {
  appendAuditLog,
  loadProjectDefinition,
  projectDefinitionPath,
  stampChangedToken,
} from "./resolve.js";

export const FIELD_ALLOW_DESTRUCTIVE_GH_VERBS = "plan.policy.allowDestructiveGhVerbs";
export const FIELD_ALLOW_DESTRUCTIVE_GH_VERBS_CLI_ALIAS = "allowDestructiveGhVerbs";
export const ALLOW_DESTRUCTIVE_GH_VERBS_SUBCOMMAND = "allow-destructive-gh-verbs";
export const ENFORCE_DESTRUCTIVE_GH_VERBS_SUBCOMMAND = "enforce-destructive-gh-verbs";

export type DestructiveGhPolicySource = "typed" | "default-fail-closed";

export interface DestructiveGhPolicyResult {
  readonly allowDestructiveGhVerbs: boolean;
  readonly source: DestructiveGhPolicySource;
  readonly error: string | null;
}

export interface DestructiveGhPolicyField {
  readonly name: string;
  readonly current: boolean;
  readonly default: boolean;
  readonly source: string;
}

export const ALLOW_DESTRUCTIVE_GH_VERBS_CAPABILITY_COST =
  "\u26a0 Capability-cost disclosure -- allowing destructive GitHub verbs turns OFF " +
  "the deft #1019 preflight-gh gate.\n" +
  "  \u2022 Pre-push will no longer block default-branch create, update, or delete.\n" +
  "  \u2022 preflight-gh --command will no longer refuse classified destructive verbs.\n" +
  "  \u2022 The env-var DEFT_ALLOW_DESTRUCTIVE_GH_VERBS stays an override, not the " +
  "documented bootstrap step.\n" +
  "  \u2022 Reversible: run `" +
  policyColonInvocation(ENFORCE_DESTRUCTIVE_GH_VERBS_SUBCOMMAND) +
  "`.\n" +
  "  \u2022 The change is recorded to meta/policy-changes.log for auditability.";

function pythonTypeName(value: unknown): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (typeof value === "object") return "dict";
  return typeof value;
}

/** Resolve typed plan.policy.allowDestructiveGhVerbs. Default fail-closed. */
export function resolveAllowDestructiveGhVerbs(projectRoot: string): DestructiveGhPolicyResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return {
      allowDestructiveGhVerbs: false,
      source: "default-fail-closed",
      error: err,
    };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      allowDestructiveGhVerbs: false,
      source: "default-fail-closed",
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }

  const policyBlock = readPlanPolicy(plan as Record<string, unknown>);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("allowDestructiveGhVerbs" in policyBlock)
  ) {
    return {
      allowDestructiveGhVerbs: false,
      source: "default-fail-closed",
      error: null,
    };
  }

  const raw = (policyBlock as Record<string, unknown>).allowDestructiveGhVerbs;
  if (typeof raw !== "boolean") {
    return {
      allowDestructiveGhVerbs: false,
      source: "default-fail-closed",
      error: `plan.policy.allowDestructiveGhVerbs must be a boolean; got ${pythonTypeName(raw)}`,
    };
  }

  return {
    allowDestructiveGhVerbs: raw,
    source: "typed",
    error: null,
  };
}

export function inspectAllowDestructiveGhVerbs(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): DestructiveGhPolicyField {
  if (projectRoot !== undefined && projectRoot.length > 0) {
    const resolved = resolveAllowDestructiveGhVerbs(projectRoot);
    return {
      name: FIELD_ALLOW_DESTRUCTIVE_GH_VERBS,
      current: resolved.allowDestructiveGhVerbs,
      default: false,
      source: resolved.source,
    };
  }
  if (data === null) {
    return {
      name: FIELD_ALLOW_DESTRUCTIVE_GH_VERBS,
      current: false,
      default: false,
      source: "default",
    };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    "allowDestructiveGhVerbs" in (policyBlock as Record<string, unknown>)
  ) {
    const raw = (policyBlock as Record<string, unknown>).allowDestructiveGhVerbs;
    return {
      name: FIELD_ALLOW_DESTRUCTIVE_GH_VERBS,
      current: typeof raw === "boolean" ? raw : false,
      default: false,
      source: "typed",
    };
  }
  return {
    name: FIELD_ALLOW_DESTRUCTIVE_GH_VERBS,
    current: false,
    default: false,
    source: "default",
  };
}

export type DestructiveGhPolicyWriteResult =
  | { readonly ok: true; readonly changed: boolean; readonly auditEntry: string }
  | { readonly ok: false; readonly message: string };

/** Write plan.policy.allowDestructiveGhVerbs with an audit row. */
export function setAllowDestructiveGhVerbs(
  projectRoot: string,
  options: {
    allowDestructiveGhVerbs: boolean;
    actor?: string;
    note?: string;
  },
): DestructiveGhPolicyWriteResult {
  const { allowDestructiveGhVerbs, actor = "agent", note = "" } = options;
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    return { ok: false, message: `PROJECT-DEFINITION not found at ${path}` };
  }

  return withProjectDefinitionMutation(projectRoot, (mutation) => {
    const data = mutation.load();
    if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
      if (data.plan === undefined) {
        data.plan = {};
      } else {
        return {
          ok: false as const,
          message: "PROJECT-DEFINITION 'plan' is not an object",
        };
      }
    }
    const plan = data.plan as Record<string, unknown>;
    const legacyKeyMigrated = migrateLegacyPolicyKey(plan);
    const existingPolicy = plan[PLAN_POLICY_KEY];
    if (
      typeof existingPolicy !== "object" ||
      existingPolicy === null ||
      Array.isArray(existingPolicy)
    ) {
      if (existingPolicy === undefined) {
        plan[PLAN_POLICY_KEY] = {};
      } else {
        return { ok: false as const, message: "plan.policy is not an object" };
      }
    }
    const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
    const previous = policyBlock.allowDestructiveGhVerbs;
    policyBlock.allowDestructiveGhVerbs = Boolean(allowDestructiveGhVerbs);

    const changed = previous !== Boolean(allowDestructiveGhVerbs) || legacyKeyMigrated;
    const parts = [
      `actor=${actor}`,
      `allowDestructiveGhVerbs=${allowDestructiveGhVerbs ? "true" : "false"}`,
      `previous=${previous === undefined ? "None" : String(previous)}`,
    ];
    if (note) {
      parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
    }
    const auditEntry = stampChangedToken(parts.join(" "), changed);
    if (changed) {
      mutation.persist(data);
    }
    appendAuditLog(projectRoot, auditEntry, changed);
    return { ok: true as const, changed, auditEntry };
  });
}
