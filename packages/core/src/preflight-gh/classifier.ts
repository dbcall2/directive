/**
 * preflight-gh/classifier.ts -- Detection-bound gate for destructive gh verbs (#1019).
 *
 * TypeScript port of scripts/preflight_gh.py. Faithfully mirrors the Python
 * classifier: classify_command, evaluate_command, run_self_test, and the
 * self-test fixture table. Three-state exit:
 *   0 -- command is allowed (not destructive) or bypass is active
 *   1 -- command is destructive and no bypass
 *   2 -- config error / self-test disagreement
 */

import * as os from "node:os";
import { resolveAllowDestructiveGhVerbs } from "../policy/destructive-gh-verbs.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";

/** Environment variable that enables the per-shell bypass (mirrors Python). */
export const ENV_BYPASS = "DEFT_ALLOW_DESTRUCTIVE_GH_VERBS";

/** Default branch refs treated as protected against force-push. */
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["master", "main"]);

/** Classification result. `category` is null when the command is allowed. */
export interface Verdict {
  readonly allowed: boolean;
  readonly category: string | null;
  readonly detail: string;
  readonly recovery: string;
}

const OK_VERDICT: Verdict = {
  allowed: true,
  category: null,
  detail: "not destructive",
  recovery: "",
};

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

/**
 * Split a command string into argv-like tokens (POSIX shlex-equivalent).
 *
 * Mirrors Python's `shlex.split(command, posix=True)` but falls back to
 * whitespace splitting on malformed quotes, same as the Python version.
 */
export function tokensFromString(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\") {
        const next = command[i + 1];
        if (next !== undefined && (next === '"' || next === "\\")) {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Classifier helpers
// ---------------------------------------------------------------------------

function envBypassActive(): boolean {
  const raw = (process.env[ENV_BYPASS] ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function isGhHead(token: string): boolean {
  return token.toLowerCase() === "gh" || token.toLowerCase() === "ghx";
}

function apiInvocationIsDelete(tokens: readonly string[]): boolean {
  const valueTaking = new Set([
    "-x",
    "--method",
    "-h",
    "--header",
    "-f",
    "--field",
    "-F",
    "--raw-field",
    "--input",
    "--jq",
    "-q",
    "--template",
    "-t",
    "--hostname",
    "--cache",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    const low = tok.toLowerCase();
    if (
      (low === "-x" || low === "--method") &&
      i + 1 < tokens.length &&
      tokens[i + 1]?.toUpperCase() === "DELETE"
    ) {
      return true;
    }
    if (low.startsWith("-x=") || low.startsWith("--method=")) {
      const value = tok.split("=", 2)[1] ?? "";
      if (value.toUpperCase() === "DELETE") return true;
    }
    // -XDELETE combined form
    if (low.startsWith("-x") && low.length > 2 && low.slice(2).toUpperCase() === "DELETE") {
      return true;
    }
    // Skip value-taking flags (skip the value token that follows)
    if (valueTaking.has(low) && !tok.includes("=")) {
      i++; // skip value
    }
  }
  return false;
}

function apiEndpoint(tokens: readonly string[]): string | null {
  const valueTaking = new Set([
    "-x",
    "--method",
    "-h",
    "--header",
    "-f",
    "--field",
    "-F",
    "--raw-field",
    "--input",
    "--jq",
    "-q",
    "--template",
    "-t",
    "--hostname",
    "--cache",
  ]);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i] ?? "";
    if (!tok.startsWith("-")) {
      return tok;
    }
    if (tok.includes("=")) {
      i++;
      continue;
    }
    // -XDELETE combined
    if (tok.toLowerCase().startsWith("-x") && tok.length > 2) {
      i++;
      continue;
    }
    if (valueTaking.has(tok.toLowerCase()) && i + 1 < tokens.length) {
      i += 2;
      continue;
    }
    i++;
  }
  return null;
}

function endpointIsRepoRoot(endpoint: string): boolean {
  const lower = endpoint.toLowerCase();
  // repos/<owner>/<repo> -- but not repos/.../issues/... etc.
  // Matches: repos/owner/repo or repos/owner/repo/contents/...
  // The Python checks: endpoint matches `repos/<owner>/<repo>` (allow sub-paths too)
  if (!lower.startsWith("repos/")) return false;
  const parts = endpoint.split("/");
  // repos / owner / repo [/ ...]
  return parts.length >= 3 && (parts[1]?.length ?? 0) > 0 && (parts[2]?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Destructive category detectors
// ---------------------------------------------------------------------------

function detectDeleteRepo(tokens: readonly string[]): Verdict | null {
  if (tokens.length < 2) return null;
  const head = tokens[0] ?? "";
  if (!isGhHead(head)) return null;

  // gh repo delete <target>
  if (
    tokens[1]?.toLowerCase() === "repo" &&
    tokens.length >= 3 &&
    tokens[2]?.toLowerCase() === "delete"
  ) {
    const target = tokens[3] ?? "<unspecified>";
    return {
      allowed: false,
      category: "delete_repo",
      detail: `gh repo delete ${target}`,
      recovery: [
        "  Repo deletion is irreversible. If this is intentional:",
        `    • opt out via the typed surface:  ${policyColonInvocation("allow-destructive-gh-verbs", " -- --confirm")}`,
        `    • or set the env-var override for this invocation:  ${ENV_BYPASS}=1`,
        "    • or run the deletion via the GitHub web UI so the",
        "      reversible-archive prompt fires (preferred).",
      ].join(os.EOL),
    };
  }

  // gh api ... DELETE repos/<owner>/<repo>...
  if (tokens[1]?.toLowerCase() === "api" && apiInvocationIsDelete(tokens.slice(2))) {
    const endpoint = apiEndpoint(tokens.slice(2));
    if (endpoint !== null && endpointIsRepoRoot(endpoint)) {
      return {
        allowed: false,
        category: "delete_repo",
        detail: `gh api -X DELETE ${endpoint}`,
        recovery: [
          "  Repo / repo-subresource deletion via the API is",
          "  irreversible. If this is intentional:",
          `    • opt out via the typed surface:  ${policyColonInvocation("allow-destructive-gh-verbs", " -- --confirm")}`,
          `    • or set the env-var override for this invocation:  ${ENV_BYPASS}=1`,
        ].join(os.EOL),
      };
    }
  }

  return null;
}

function detectAdminMerge(tokens: readonly string[]): Verdict | null {
  if (tokens.length < 2) return null;
  const head = tokens[0] ?? "";
  if (!isGhHead(head)) return null;
  if (tokens[1]?.toLowerCase() !== "pr") return null;
  const hasAdmin = tokens.some((t) => t.toLowerCase() === "--admin");
  const hasMerge = tokens.some((t) => t.toLowerCase() === "merge");
  if (!hasMerge || !hasAdmin) return null;
  return {
    allowed: false,
    category: "admin_merge",
    detail: "gh pr merge --admin",
    recovery: [
      "  `gh pr merge --admin` bypasses required branch-protection reviews.",
      "  Document the rationale before using. If genuinely required:",
      `    • opt out via the typed surface:  ${policyColonInvocation("allow-destructive-gh-verbs", " -- --confirm")}`,
      `    • or set the env-var override for this invocation:  ${ENV_BYPASS}=1`,
    ].join(os.EOL),
  };
}

/** Git globals that consume the next argv token when written without `=`. */
const GIT_GLOBAL_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--list-cmds",
  "--attr-source",
  "--shallow-file",
]);

/** `git push` options that consume the next argv token when written without `=`. */
const GIT_PUSH_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
  "--repo",
  "--recurse-submodules",
]);

function optionName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

function skipOption(
  tokens: readonly string[],
  index: number,
  valueOpts: ReadonlySet<string>,
): number {
  const token = tokens[index] ?? "";
  const name = optionName(token);
  if (!token.includes("=") && valueOpts.has(name)) {
    return index + 2;
  }
  return index + 1;
}

function firstNonOptionIndex(
  tokens: readonly string[],
  start: number,
  valueOpts: ReadonlySet<string>,
): number {
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (token === "--") return i + 1;
    if (!token.startsWith("-")) return i;
    i = skipOption(tokens, i, valueOpts);
  }
  return i;
}

function collectPositionals(tokens: readonly string[], valueOpts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "--") {
      out.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("-")) {
      i = skipOption(tokens, i, valueOpts) - 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function gitPushArgTokens(tokens: readonly string[]): string[] | null {
  if (tokens.length < 2) return null;
  if ((tokens[0] ?? "").toLowerCase() !== "git") return null;
  const subIdx = firstNonOptionIndex(tokens, 1, GIT_GLOBAL_VALUE_OPTS);
  if ((tokens[subIdx] ?? "").toLowerCase() !== "push") return null;
  return tokens.slice(subIdx + 1);
}

function repoFromPushArgs(pushArgs: readonly string[]): string | null {
  for (let i = 0; i < pushArgs.length; i++) {
    const token = pushArgs[i] ?? "";
    if (token.startsWith("--repo=")) {
      const value = token.slice("--repo=".length);
      return value.length > 0 ? value : null;
    }
    if (token === "--repo") {
      const next = pushArgs[i + 1] ?? "";
      return next.length > 0 && !next.startsWith("-") ? next : null;
    }
  }
  return null;
}

function hasBulkDefaultUpdate(pushArgs: readonly string[]): boolean {
  return pushArgs.some((t) => t === "--all" || t === "--mirror");
}

function destRefspecs(pushArgs: readonly string[]): string[] {
  const positionals = collectPositionals(pushArgs, GIT_PUSH_VALUE_OPTS);
  // One positional with `--repo` is the dest (`git push --repo=origin master`).
  // Two or more positionals: the first is the repository and overrides `--repo`
  // (`git push --repo=backup main feat/x`).
  if (repoFromPushArgs(pushArgs) !== null && positionals.length <= 1) {
    return positionals;
  }
  return positionals.slice(1);
}

function refspecDest(spec: string): string {
  const withoutForce = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = withoutForce.lastIndexOf(":");
  return colon === -1 ? withoutForce : withoutForce.slice(colon + 1);
}

function hasForcePush(pushArgs: readonly string[]): boolean {
  if (
    pushArgs.some(
      (t) =>
        t === "--force" ||
        t === "-f" ||
        t === "--force-with-lease" ||
        t.startsWith("--force-with-lease="),
    )
  ) {
    return true;
  }
  return destRefspecs(pushArgs).some((spec) => spec.startsWith("+") && !spec.startsWith("+-"));
}

function destLooksLikeDefaultBranch(dest: string, branchesLower: ReadonlySet<string>): boolean {
  const stripped = dest.replace(/^refs\/heads\//, "");
  return branchesLower.has(dest.toLowerCase()) || branchesLower.has(stripped.toLowerCase());
}

function targetsDefaultBranch(
  pushArgs: readonly string[],
  defaultBranches: ReadonlySet<string>,
): boolean {
  if (hasBulkDefaultUpdate(pushArgs)) return true;
  const branchesLower = new Set([...defaultBranches].map((b) => b.toLowerCase()));
  return destRefspecs(pushArgs).some((spec) =>
    destLooksLikeDefaultBranch(refspecDest(spec), branchesLower),
  );
}

function policyHowToProceed(): string {
  return [
    `    • opt out via the typed surface:  ${policyColonInvocation("allow-destructive-gh-verbs", " -- --confirm")}`,
    `    • or set the env-var override for this invocation:  ${ENV_BYPASS}=1`,
  ].join(os.EOL);
}

function detectForcePushDefault(
  tokens: readonly string[],
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
): Verdict | null {
  const allTokens = gitPushArgTokens(tokens);
  if (allTokens === null) return null;
  if (!hasForcePush(allTokens)) return null;
  if (!targetsDefaultBranch(allTokens, defaultBranches)) return null;

  const forceKind = allTokens.some(
    (t) => t === "--force-with-lease" || t.startsWith("--force-with-lease="),
  )
    ? "--force-with-lease"
    : destRefspecs(allTokens).some((t) => t.startsWith("+") && !t.startsWith("+-"))
      ? "refspec +"
      : "--force";

  return {
    allowed: false,
    category: "force_push_default",
    detail: `git push ${forceKind} to default branch`,
    recovery: [
      "  Force-pushing to the default branch is irreversible and rewrites",
      "  public history. If genuinely required:",
      policyHowToProceed(),
      "    • or push to a feature branch and use a PR.",
    ].join(os.EOL),
  };
}

function detectPushDefault(
  tokens: readonly string[],
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
): Verdict | null {
  const allTokens = gitPushArgTokens(tokens);
  if (allTokens === null) return null;
  if (hasForcePush(allTokens)) return null;
  if (!targetsDefaultBranch(allTokens, defaultBranches)) return null;

  return {
    allowed: false,
    category: "push_default",
    detail: "git push to default branch",
    recovery: [
      "  Pushing directly to the default branch is refused (#1019).",
      "  How to proceed:",
      "    • push to a feature branch and open a PR",
      policyHowToProceed(),
    ].join(os.EOL),
  };
}

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

/**
 * Classify a candidate command string.
 *
 * Mirrors `preflight_gh.py::classify_command`. Returns a Verdict with
 * `allowed=false` and a destructive category name, or `{allowed:true,
 * category:null}` when the command is benign.
 */
export function classifyCommand(
  command: string,
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
): Verdict {
  const tokens = tokensFromString(command);
  return (
    detectDeleteRepo(tokens) ??
    detectAdminMerge(tokens) ??
    detectForcePushDefault(tokens, defaultBranches) ??
    detectPushDefault(tokens, defaultBranches) ??
    OK_VERDICT
  );
}

/**
 * Evaluate a single candidate command; respects the env-var bypass.
 *
 * Returns `[exitCode, message]` -- mirrors `preflight_gh.py::evaluate_command`.
 */
export function evaluateCommand(
  command: string,
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
  options: { projectRoot?: string } = {},
): [number, string] {
  if (envBypassActive()) {
    return [
      0,
      `⚠ deft destructive-gh-verb gate: ${ENV_BYPASS}=1 is set -- policy bypassed for this invocation.`,
    ];
  }
  const verdict = classifyCommand(command, defaultBranches);
  if (verdict.allowed) {
    return [0, `✓ deft destructive-gh-verb gate: '${command}' -- not destructive.`];
  }
  const projectRoot = options.projectRoot;
  if (projectRoot !== undefined && projectRoot.length > 0) {
    const policy = resolveAllowDestructiveGhVerbs(projectRoot);
    if (policy.error) {
      return [
        2,
        [
          "❌ deft destructive-gh-verb gate: PROJECT-DEFINITION cannot be resolved.",
          `  Detail: ${policy.error}`,
        ].join(os.EOL),
      ];
    }
    if (policy.allowDestructiveGhVerbs) {
      return [
        0,
        `⚠ deft destructive-gh-verb gate: refusing '${command}' would apply, but plan.policy.allowDestructiveGhVerbs=true -- policy allowed for this invocation.`,
      ];
    }
  }
  const msg = [
    `❌ deft destructive-gh-verb gate: refusing '${command}'.`,
    `  Category: ${verdict.category}`,
    `  Detail: ${verdict.detail}`,
    verdict.recovery,
  ]
    .filter((l) => l.length > 0)
    .join(os.EOL);
  return [1, msg];
}

// ---------------------------------------------------------------------------
// Self-test fixture table (mirrors _SELF_TEST_CASES in preflight_gh.py)
// ---------------------------------------------------------------------------

type Fixture = readonly [command: string, expectedCategory: string | null];

export const SELF_TEST_CASES: readonly Fixture[] = [
  // delete_repo positives
  ["gh repo delete deftai/directive", "delete_repo"],
  ["gh repo delete deftai/directive --yes", "delete_repo"],
  ["gh api -X DELETE repos/deftai/directive", "delete_repo"],
  ["gh api --method DELETE repos/deftai/directive/contents/README.md", "delete_repo"],
  ["gh api -XDELETE repos/deftai/directive", "delete_repo"],
  // admin_merge positives
  ["gh pr merge 123 --admin", "admin_merge"],
  ["gh pr merge --admin --squash 123", "admin_merge"],
  // force_push_default positives
  ["git push --force origin master", "force_push_default"],
  ["git push origin --force-with-lease main", "force_push_default"],
  ["git push origin +master", "force_push_default"],
  ["git push --force origin HEAD:master", "force_push_default"],
  // Negatives -- benign commands MUST classify as allowed.
  ["gh pr merge 123 --squash", null],
  ["gh repo view deftai/directive", null],
  ["gh api repos/deftai/directive", null],
  ["gh api -X PATCH repos/deftai/directive/issues/1", null],
  ["git push origin feat/my-branch", null],
  ["git push --force origin feat/my-branch", null],
  ["git push --force-with-lease origin feat/my-branch", null],
  ["git push", null],
  ["git remote add push master", null],
  ["git push main my-feature", null],
  ["git push origin master", "push_default"],
  ["git push -u origin master", "push_default"],
  ["git push origin main", "push_default"],
  ["git push --repo=origin master", "push_default"],
  ["git push --repo origin master", "push_default"],
  ["git push --all origin", "push_default"],
  ["git push origin --all", "push_default"],
  ["git push --mirror origin", "push_default"],
  ["git push --repo=origin --all", "push_default"],
  ["git push --force --repo=origin master", "force_push_default"],
  ["git push --repo=origin feat/my-branch", null],
  ["git push --repo=backup main feat/x", null],
  ["gh pr create --title Test --body foo", null],
] as const;

/**
 * Run every self-test fixture through the classifier.
 *
 * @param fixtures - Optional override fixture table (defaults to SELF_TEST_CASES).
 *   Inject a contrived table in tests to exercise the failure-path branch.
 *
 * Returns `[exitCode, message]`. Exit 0 = all pass; exit 2 = disagreement
 * (config error / classifier drift) -- mirrors `preflight_gh.py::run_self_test`.
 */
export function runSelfTest(fixtures?: readonly Fixture[]): [number, string] {
  const cases = fixtures ?? SELF_TEST_CASES;
  const failures: string[] = [];
  for (const [command, expected] of cases) {
    const verdict = classifyCommand(command);
    const observed = verdict.allowed ? null : verdict.category;
    if (observed !== expected) {
      failures.push(
        `  ✗ ${JSON.stringify(command)} -- expected category=${JSON.stringify(expected)} but got category=${JSON.stringify(observed)} (detail=${JSON.stringify(verdict.detail)})`,
      );
    }
  }
  if (failures.length > 0) {
    return [
      2,
      [
        `❌ deft destructive-gh-verb gate (self-test): classifier disagreement on ${failures.length}/${cases.length} fixture(s).`,
        ...failures,
      ].join(os.EOL),
    ];
  }
  return [
    0,
    `✓ deft destructive-gh-verb gate (self-test): ${cases.length}/${cases.length} fixtures classified as expected.`,
  ];
}
