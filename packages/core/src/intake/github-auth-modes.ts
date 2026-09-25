import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { CompletedProcess } from "../scm/call.js";
import { pyRepr } from "../scm/py-format.js";
import {
  getPlatformCapabilities,
  probeRuntimeCapabilities,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
  type RuntimeCapabilityReport,
} from "./platform-capabilities.js";

export const GITHUB_AUTH_MODE_INJECTED_TOKEN = "injected-token";
export const GITHUB_AUTH_MODE_HOST_GH = "host-gh";

export const KNOWN_GITHUB_AUTH_MODES = new Set<string>([
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  GITHUB_AUTH_MODE_HOST_GH,
]);

export const PRINCIPAL_KIND_USER = "user";

export const FAILURE_MISSING_INJECTED_TOKEN = "missing_injected_token";
export const FAILURE_GH_AUTH = "gh_auth_failed";
export const FAILURE_API_UNREACHABLE = "api_unreachable";
export const FAILURE_REPO_ACCESS = "repo_access_denied";
export const FAILURE_INVALID_MODE = "invalid_auth_mode";
export const FAILURE_MISSING_EXPECTED_PRINCIPAL = "missing_expected_principal";
export const FAILURE_PRINCIPAL_MISMATCH = "principal_mismatch";
export const FAILURE_MISSING_TARGET_REPO = "missing_target_repo";
export const FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE = "installation_identity_unverifiable";

export const ENV_EXPECTED_GITHUB_LOGIN = "DEFT_EXPECTED_GITHUB_LOGIN";

export const INSTALLATION_IDENTITY_ISSUE_URL = "https://github.com/deftai/directive/issues/3693";

const INJECTED_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;
const DOTCOM_OR_GHE_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const GHES_TOKEN_ENV_VARS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;
const DEFAULT_GITHUB_HOST = "github.com";

export type GithubHostFamily = "dotcom-or-ghe" | "ghes";
export type GithubCredentialSource = "injected-token" | "host-store";

const SANDBOX_REMEDIATION =
  "Remediation options for worker sandbox GitHub auth failures:\n" +
  "  - Run the GitHub step with full-access execution\n" +
  "  - Allowlist the trusted gh command path for the worker sandbox\n" +
  "  - Use injected-token handoff (keep token values out of prompts and transcripts)";

const REPO_ACCESS_REMEDIATION =
  "Remediation options for repo-access failures:\n" +
  "  - Confirm the worker credential can read the target repository\n" +
  "  - Run the GitHub step with full-access execution if host gh has access\n" +
  "  - Use injected-token handoff scoped to the required repository";

const PRINCIPAL_REMEDIATION =
  "Remediation for GitHub worker-principal failures:\n" +
  "  - User-bearing credential: pass expectedPrincipal.login or set DEFT_EXPECTED_GITHUB_LOGIN\n" +
  "  - Do not treat a /user 403 on an installation token as API unreachability\n" +
  "  - GitHub App installation identity cannot be verified from the token; see #3693";

const INSTALLATION_IDENTITY_REMEDIATION =
  "A GitHub App installation token cannot prove which App it belongs to.\n" +
  `Tracked in ${INSTALLATION_IDENTITY_ISSUE_URL}. Do not treat a /user 403 as API unreachability.`;

const TARGET_REPO_REMEDIATION =
  "Remediation for missing target repository:\n" +
  "  - Pass repo as owner/repo, or set GH_REPO / GITHUB_REPOSITORY, or run inside a git checkout with origin\n" +
  "  - Do not fall back to a hard-coded public default";

/** GitHub-specific expected worker principal. Not a universal (provider-neutral) identity. */
export type ExpectedGithubWorkerPrincipal = { readonly kind: "user"; readonly login: string };

export interface GitHubAuthValidationResult {
  readonly ok: boolean;
  readonly githubAuthMode: string;
  readonly runtimeMode: string | null;
  readonly failureKind: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly login: string | null;
  readonly principal: ExpectedGithubWorkerPrincipal | null;
  readonly validationRepo: string | null;
  readonly githubHost: string | null;
  readonly credentialSource: GithubCredentialSource | null;
  readonly applicableTokenEnv: string | null;
  readonly installationAuthenticated: boolean;
}

export type GhRunner = (args: readonly string[], environ: NodeJS.ProcessEnv) => CompletedProcess;
export type GitRemoteReader = (cwd?: string) => string | null;

export interface GithubAuthValidationOptions {
  repo?: string;
  host?: string | null;
  runtimeMode?: string | null;
  runGh?: GhRunner;
  expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
  gitRemoteUrl?: string | null;
  readGitRemote?: GitRemoteReader;
  cwd?: string;
}

export function findInjectedToken(environ: NodeJS.ProcessEnv): string | null {
  for (const name of INJECTED_TOKEN_ENV_VARS) {
    const value = environ[name]?.trim() ?? "";
    if (value.length > 0) {
      return value;
    }
  }
  return null;
}

export function normalizeGithubHostname(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "api.github.com") {
    return DEFAULT_GITHUB_HOST;
  }
  return trimmed;
}

export function isDotcomOrGheHost(host: string): boolean {
  const normalized = normalizeGithubHostname(host);
  return (
    normalized === DEFAULT_GITHUB_HOST ||
    normalized === "ghe.com" ||
    normalized.endsWith(".ghe.com")
  );
}

export function githubHostFamily(host: string): GithubHostFamily {
  return isDotcomOrGheHost(host) ? "dotcom-or-ghe" : "ghes";
}

export function applicableTokenEnvNames(host: string): readonly string[] {
  return githubHostFamily(host) === "ghes" ? GHES_TOKEN_ENV_VARS : DOTCOM_OR_GHE_TOKEN_ENV_VARS;
}

export function parseGithubHostFromRemote(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0) {
    return null;
  }
  const scp = raw.match(/^git@([^:]+):/);
  if (scp?.[1]) {
    return normalizeGithubHostname(scp[1]);
  }
  try {
    const withProto = raw.includes("://") ? raw : `https://${raw}`;
    const parsed = new URL(withProto);
    if (parsed.hostname.length > 0) {
      return normalizeGithubHostname(parsed.hostname);
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveGithubHost(options: {
  host?: string | null;
  environ?: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
  readGitRemote?: GitRemoteReader;
  cwd?: string;
}): string {
  const explicit = options.host?.trim() ?? "";
  if (explicit.length > 0) {
    return normalizeGithubHostname(explicit);
  }
  const envHost = (options.environ?.GH_HOST ?? "").trim();
  if (envHost.length > 0) {
    return normalizeGithubHostname(envHost);
  }
  // Explicit null skips origin lookup (mode inference / skip-readiness).
  // Undefined still honors repository context via origin.
  const remote =
    options.gitRemoteUrl !== undefined
      ? options.gitRemoteUrl
      : (options.readGitRemote ?? defaultReadGitOriginUrl)(options.cwd);
  if (typeof remote === "string" && remote.trim().length > 0) {
    const fromRemote = parseGithubHostFromRemote(remote);
    if (fromRemote !== null) {
      return fromRemote;
    }
  }
  return DEFAULT_GITHUB_HOST;
}

export function findApplicableInjectedToken(
  environ: NodeJS.ProcessEnv,
  host: string,
): { readonly name: string; readonly value: string } | null {
  for (const name of applicableTokenEnvNames(host)) {
    const value = environ[name]?.trim() ?? "";
    if (value.length > 0) {
      return { name, value };
    }
  }
  return null;
}

export function tokenPresenceFingerprint(environ: NodeJS.ProcessEnv, host: string): string {
  return applicableTokenEnvNames(host)
    .map((name) => {
      const value = (environ[name] ?? "").trim();
      if (value.length === 0) {
        return `${name}:0`;
      }
      const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
      return `${name}:${digest}`;
    })
    .join(",");
}

function environFromInferInput(
  environOrReport: NodeJS.ProcessEnv | RuntimeCapabilityReport,
): NodeJS.ProcessEnv {
  if (
    environOrReport !== null &&
    typeof environOrReport === "object" &&
    "runtimeMode" in environOrReport &&
    typeof (environOrReport as RuntimeCapabilityReport).runtimeMode === "string" &&
    !("PATH" in environOrReport)
  ) {
    return process.env;
  }
  return environOrReport as NodeJS.ProcessEnv;
}

/**
 * Effective source for the target host. Runtime/socket labels are not inputs.
 * A RuntimeCapabilityReport first argument is accepted for existing callers
 * and is ignored for admission (#5016).
 */
export function inferGithubAuthMode(
  environOrReport: NodeJS.ProcessEnv | RuntimeCapabilityReport = process.env,
  options: { host?: string | null } = {},
): string {
  const environ = environFromInferInput(environOrReport);
  const host = resolveGithubHost({
    environ,
    host: options.host,
    gitRemoteUrl: null,
  });
  return findApplicableInjectedToken(environ, host) !== null
    ? GITHUB_AUTH_MODE_INJECTED_TOKEN
    : GITHUB_AUTH_MODE_HOST_GH;
}

export function githubApiArgs(path: string, host: string): string[] {
  const normalized = path.replace(/^\//, "");
  if (!host || host === DEFAULT_GITHUB_HOST) {
    return ["api", normalized];
  }
  return ["api", "--hostname", host, normalized];
}

export function githubApiPath(args: readonly string[]): string | null {
  if (args[0] !== "api") {
    return null;
  }
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--hostname" || token === "-H" || token === "--header" || token === "--jq") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.replace(/^\//, "");
  }
  return null;
}

export function isWellFormedInstallationRepositories(stdout: string): boolean {
  try {
    const payload = JSON.parse(stdout) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.repositories)) {
      return true;
    }
    return typeof rec.total_count === "number";
  } catch {
    return false;
  }
}

function isUnauthenticatedInstallationProbe(proc: CompletedProcess): boolean {
  const blob = combinedGhText(proc).toLowerCase();
  return (
    blob.includes("requires authentication") ||
    blob.includes("bad credentials") ||
    blob.includes("http 401") ||
    /"status"\s*:\s*"?401"?/.test(blob)
  );
}

/**
 * Prefer live `gh` for auth/API validation. Do not route through scm.call /
 * BINARY_PREFERENCE (ghx-first): ghx is a cached GET proxy and rejects multi-arg
 * `api user --jq .login` forms used here (#2275 Greptile P1 / #954).
 */
function defaultRunGh(args: readonly string[], environ: NodeJS.ProcessEnv): CompletedProcess {
  const binary = "gh";
  try {
    const result = spawnSync(binary, [...args], {
      env: environ,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      args: [binary, ...args],
      returncode: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { args: [binary, ...args], returncode: 1, stdout: "", stderr: message };
  }
}

export function defaultReadGitOriginUrl(cwd?: string): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((result.status ?? 1) !== 0) {
      return null;
    }
    const url = (typeof result.stdout === "string" ? result.stdout : "").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export function parseOwnerRepoSlug(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }
  const direct = raw.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (direct) {
    return `${direct[1]}/${direct[2]}`;
  }
  const stripped = raw.replace(/\.git$/i, "");
  // SCP form including GitHub Enterprise: git@host:owner/repo
  if (!stripped.includes("://")) {
    const scp = stripped.match(/:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    if (scp) {
      return `${scp[1]}/${scp[2]}`;
    }
  }
  const fromUrl = stripped.match(/[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (fromUrl) {
    return `${fromUrl[1]}/${fromUrl[2]}`;
  }
  return null;
}

export function deriveValidationRepo(options: {
  repo?: string;
  environ?: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
  readGitRemote?: GitRemoteReader;
  cwd?: string;
}): { ok: true; repo: string } | { ok: false; detail: string } {
  if (options.repo !== undefined && options.repo !== null) {
    const parsed = parseOwnerRepoSlug(options.repo);
    if (parsed === null) {
      return {
        ok: false,
        detail: `invalid repository slug: ${JSON.stringify(options.repo)} (expected owner/repo)`,
      };
    }
    return { ok: true, repo: parsed };
  }
  const env = options.environ ?? {};
  const fromEnv = (env.GH_REPO ?? env.GITHUB_REPOSITORY ?? "").trim();
  if (fromEnv.length > 0) {
    const parsed = parseOwnerRepoSlug(fromEnv);
    if (parsed === null) {
      return {
        ok: false,
        detail: `invalid repository slug from GH_REPO/GITHUB_REPOSITORY: ${JSON.stringify(fromEnv)}`,
      };
    }
    return { ok: true, repo: parsed };
  }
  const remote =
    options.gitRemoteUrl !== undefined && options.gitRemoteUrl !== null
      ? options.gitRemoteUrl
      : (options.readGitRemote ?? defaultReadGitOriginUrl)(options.cwd);
  if (typeof remote === "string" && remote.trim().length > 0) {
    const parsed = parseOwnerRepoSlug(remote);
    if (parsed === null) {
      return {
        ok: false,
        detail: `invalid git origin URL for repository derivation: ${JSON.stringify(remote.trim())}`,
      };
    }
    return { ok: true, repo: parsed };
  }
  return {
    ok: false,
    detail:
      "cannot derive target repository; pass repo as owner/repo, set GH_REPO or GITHUB_REPOSITORY, or run inside a git checkout with origin",
  };
}

export function resolveExpectedGithubWorkerPrincipal(
  environ: NodeJS.ProcessEnv,
  explicit?: ExpectedGithubWorkerPrincipal | null,
): ExpectedGithubWorkerPrincipal | { error: string } | null {
  if (explicit === null) {
    return null;
  }
  if (explicit !== undefined) {
    return normalizeExpectedPrincipal(explicit);
  }
  const login = environ[ENV_EXPECTED_GITHUB_LOGIN]?.trim() ?? "";
  if (login.length > 0) {
    return { kind: PRINCIPAL_KIND_USER, login };
  }
  return null;
}

function normalizeExpectedPrincipal(
  principal: ExpectedGithubWorkerPrincipal,
): ExpectedGithubWorkerPrincipal | { error: string } {
  if (principal.kind !== PRINCIPAL_KIND_USER) {
    return {
      error: `unknown expected principal kind ${pyRepr((principal as { kind: string }).kind)}`,
    };
  }
  const login = principal.login.trim();
  if (login.length === 0) {
    return { error: "user principal requires a non-empty login" };
  }
  return { kind: PRINCIPAL_KIND_USER, login };
}

function splitRepo(repo: string): [string, string] {
  const idx = repo.indexOf("/");
  if (idx <= 0 || idx >= repo.length - 1) {
    throw new Error(`invalid repository slug: ${JSON.stringify(repo)} (expected owner/repo)`);
  }
  return [repo.slice(0, idx), repo.slice(idx + 1)];
}

function sandboxRemediation(runtimeMode: string | null, failureKind: string): string | null {
  if (runtimeMode !== RUNTIME_MODE_CURSOR_NATIVE_SANDBOX) {
    return null;
  }
  if (
    failureKind === FAILURE_GH_AUTH ||
    failureKind === FAILURE_API_UNREACHABLE ||
    failureKind === FAILURE_REPO_ACCESS ||
    failureKind === FAILURE_MISSING_EXPECTED_PRINCIPAL ||
    failureKind === FAILURE_PRINCIPAL_MISMATCH ||
    failureKind === FAILURE_MISSING_TARGET_REPO ||
    failureKind === FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE
  ) {
    return SANDBOX_REMEDIATION;
  }
  return null;
}

function extraRemediation(failureKind: string): string | null {
  if (failureKind === FAILURE_REPO_ACCESS) {
    return REPO_ACCESS_REMEDIATION;
  }
  if (failureKind === FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE) {
    return INSTALLATION_IDENTITY_REMEDIATION;
  }
  if (
    failureKind === FAILURE_MISSING_EXPECTED_PRINCIPAL ||
    failureKind === FAILURE_PRINCIPAL_MISMATCH
  ) {
    return PRINCIPAL_REMEDIATION;
  }
  if (failureKind === FAILURE_MISSING_TARGET_REPO) {
    return TARGET_REPO_REMEDIATION;
  }
  return null;
}

function mergeRemediation(runtimeMode: string | null, failureKind: string): string | null {
  const parts: string[] = [];
  const sandbox = sandboxRemediation(runtimeMode, failureKind);
  if (sandbox !== null) {
    parts.push(sandbox);
  }
  const extra = extraRemediation(failureKind);
  if (extra !== null && !parts.includes(extra)) {
    parts.push(extra);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** CSI/SGR only ΓÇö gh color wraps `/user` JSON (`CLICOLOR_FORCE`). */
function stripGhAnsi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 27 || text[i + 1] !== "[") {
      out += text[i];
      continue;
    }
    i += 2;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code >= 64 && code <= 126) {
        break;
      }
      i += 1;
    }
  }
  return out;
}

/** Token-shaped prefixes that must never appear in login/detail/remediation (#3664 R4). */
export const TOKEN_SHAPED_RE = /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/gi;

export function containsTokenShapedText(text: string): boolean {
  TOKEN_SHAPED_RE.lastIndex = 0;
  const found = TOKEN_SHAPED_RE.test(text);
  TOKEN_SHAPED_RE.lastIndex = 0;
  return found;
}

function redactTokenShaped(text: string): string {
  TOKEN_SHAPED_RE.lastIndex = 0;
  return text.replace(TOKEN_SHAPED_RE, "[redacted]");
}

function isUsableLogin(value: string): boolean {
  if (value.length === 0 || value.includes("\n") || value.includes("{")) {
    return false;
  }
  return !containsTokenShapedText(value);
}

export function parseLogin(stdout: string): string | null {
  const text = stripGhAnsi(stdout).trim();
  if (text.length === 0) {
    return null;
  }
  try {
    const payload = JSON.parse(text) as unknown;
    if (typeof payload === "string" && isUsableLogin(payload)) {
      return payload;
    }
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const login = (payload as Record<string, unknown>).login;
      if (typeof login === "string" && isUsableLogin(login)) {
        return login;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function combinedGhText(proc: CompletedProcess): string {
  return `${proc.stdout}\n${proc.stderr}`;
}

export function isInstallationUserEndpointInapplicable(proc: CompletedProcess): boolean {
  const blob = combinedGhText(proc).toLowerCase();
  return (
    blob.includes("resource not accessible by integration") ||
    blob.includes("not accessible by integration")
  );
}

function parseGhApiMessage(proc: CompletedProcess): string | null {
  const chunks = [proc.stdout, proc.stderr]
    .map((chunk) => stripGhAnsi(chunk).trim())
    .filter((text) => text.length > 0);
  for (const text of chunks) {
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        const message = (payload as Record<string, unknown>).message;
        if (typeof message === "string" && message.length > 0) {
          const status = (payload as Record<string, unknown>).status;
          if (typeof status === "string" || typeof status === "number") {
            return `${message} (HTTP ${status})`;
          }
          return message;
        }
      }
    } catch {
      // Prefer JSON from a later chunk before using sanitized non-JSON text.
    }
  }
  for (const text of chunks) {
    const firstLine = redactTokenShaped(text).split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (firstLine.length > 0 && !containsTokenShapedText(firstLine)) {
      return firstLine;
    }
  }
  return null;
}

function isNetworkUnreachableText(text: string): boolean {
  return /timed out|timeout|econnrefused|enotfound|eai_again|network is unreachable|could not resolve host/i.test(
    text,
  );
}

export function formatUserApiFailureDetail(mode: string, proc: CompletedProcess): string {
  const parsed = parseGhApiMessage(proc);
  const prefix =
    mode === GITHUB_AUTH_MODE_INJECTED_TOKEN
      ? "injected token present but GitHub /user failed"
      : "gh auth status passed but GitHub /user failed";
  const classifyBlob = `${parsed ?? ""}\n${combinedGhText(proc)}`;
  if (isNetworkUnreachableText(parsed ?? "") || isNetworkUnreachableText(classifyBlob)) {
    return `${prefix}: GitHub API is unreachable`;
  }
  if (parsed !== null && !containsTokenShapedText(parsed)) {
    return `${prefix}: ${parsed}`;
  }
  return `${prefix}: exit ${proc.returncode}`;
}

function emptyResult(
  mode: string,
  runtimeMode: string | null,
  failureKind: string | null,
  detail: string,
  options: {
    ok?: boolean;
    login?: string | null;
    principal?: ExpectedGithubWorkerPrincipal | null;
    validationRepo?: string | null;
    githubHost?: string | null;
    credentialSource?: GithubCredentialSource | null;
    applicableTokenEnv?: string | null;
    installationAuthenticated?: boolean;
  } = {},
): GitHubAuthValidationResult {
  const ok = options.ok ?? false;
  const login = options.login ?? null;
  const remediation = ok ? null : mergeRemediation(runtimeMode, failureKind ?? "");
  return {
    ok,
    githubAuthMode: mode,
    runtimeMode,
    failureKind: ok ? null : failureKind,
    detail: redactTokenShaped(detail),
    remediation: remediation === null ? null : redactTokenShaped(remediation),
    login: login !== null && containsTokenShapedText(login) ? null : login,
    principal: options.principal ?? null,
    validationRepo: options.validationRepo ?? null,
    githubHost: options.githubHost ?? null,
    credentialSource: options.credentialSource ?? null,
    applicableTokenEnv: options.applicableTokenEnv ?? null,
    installationAuthenticated: options.installationAuthenticated === true,
  };
}

function loginsMatch(expected: string, observed: string): boolean {
  return expected.localeCompare(observed, undefined, { sensitivity: "accent" }) === 0;
}

interface SourceContext {
  readonly githubHost: string;
  readonly credentialSource: GithubCredentialSource;
  readonly applicableTokenEnv: string | null;
}

function withSource(
  source: SourceContext,
  extras: {
    ok?: boolean;
    login?: string | null;
    principal?: ExpectedGithubWorkerPrincipal | null;
    validationRepo?: string | null;
    installationAuthenticated?: boolean;
  } = {},
): {
  ok?: boolean;
  login?: string | null;
  principal?: ExpectedGithubWorkerPrincipal | null;
  validationRepo?: string | null;
  githubHost: string;
  credentialSource: GithubCredentialSource;
  applicableTokenEnv: string | null;
  installationAuthenticated?: boolean;
} {
  return {
    ...extras,
    githubHost: source.githubHost,
    credentialSource: source.credentialSource,
    applicableTokenEnv: source.applicableTokenEnv,
  };
}

function failClosedInstallationCredential(
  mode: string,
  runtimeMode: string | null,
  repo: string,
  source: SourceContext,
): GitHubAuthValidationResult {
  return emptyResult(
    mode,
    runtimeMode,
    FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
    "GitHub /user is inapplicable to a GitHub App installation credential (no authenticated user). " +
      "The API is reachable. An installation token cannot disclose which App it belongs to, " +
      `so identity cannot be verified. Deferred to ${INSTALLATION_IDENTITY_ISSUE_URL}. ` +
      "Installation credentials cannot satisfy a required user principal.",
    withSource(source, { validationRepo: repo }),
  );
}

function checkTargetRepoAccess(
  mode: string,
  runtimeMode: string | null,
  runner: GhRunner,
  environ: NodeJS.ProcessEnv,
  repo: string,
  login: string | null,
  principal: ExpectedGithubWorkerPrincipal | null,
  source: SourceContext,
  installationAuthenticated = false,
): GitHubAuthValidationResult {
  const [owner, name] = splitRepo(repo);
  const repoApi = runner(githubApiArgs(`repos/${owner}/${name}`, source.githubHost), environ);
  if (repoApi.returncode !== 0) {
    const detail =
      mode === GITHUB_AUTH_MODE_INJECTED_TOKEN
        ? `injected token can reach GitHub API but cannot access ${repo}`
        : `GitHub API reachable but repository access failed for ${repo}`;
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_REPO_ACCESS,
      detail,
      withSource(source, {
        login,
        principal,
        validationRepo: repo,
        installationAuthenticated,
      }),
    );
  }
  const okDetail = installationAuthenticated
    ? "installation authentication admitted without verified user login or issuing-App identity"
    : mode === GITHUB_AUTH_MODE_INJECTED_TOKEN
      ? "injected-token mode validated in worker environment"
      : "host-gh mode validated in worker environment";
  return emptyResult(mode, runtimeMode, null, okDetail, {
    ...withSource(source, {
      ok: true,
      login,
      principal,
      validationRepo: repo,
      installationAuthenticated,
    }),
  });
}

function validateInstallationAuth(
  mode: string,
  environ: NodeJS.ProcessEnv,
  runtimeMode: string | null,
  runner: GhRunner,
  repo: string,
  source: SourceContext,
): GitHubAuthValidationResult {
  const probe = runner(githubApiArgs("installation/repositories", source.githubHost), environ);
  if (probe.returncode !== 0) {
    const unauth = isUnauthenticatedInstallationProbe(probe);
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_API_UNREACHABLE,
      unauth
        ? "GET /installation/repositories rejected unauthenticated access; installation authentication was not established"
        : formatUserApiFailureDetail(mode, probe),
      withSource(source, { validationRepo: repo }),
    );
  }
  if (!isWellFormedInstallationRepositories(probe.stdout)) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_API_UNREACHABLE,
      "GET /installation/repositories did not return a well-formed authenticated installation payload",
      withSource(source, { validationRepo: repo }),
    );
  }
  return checkTargetRepoAccess(mode, runtimeMode, runner, environ, repo, null, null, source, true);
}

function validateAfterAuth(
  mode: string,
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions,
  runtimeMode: string | null,
  runner: GhRunner,
  source: SourceContext,
): GitHubAuthValidationResult {
  const derived = deriveValidationRepo({
    repo: options.repo,
    environ,
    gitRemoteUrl: options.gitRemoteUrl,
    readGitRemote: options.readGitRemote,
    cwd: options.cwd,
  });
  if (!derived.ok) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_MISSING_TARGET_REPO,
      derived.detail,
      withSource(source),
    );
  }
  const repo = derived.repo;
  const expectedPrincipal = resolveExpectedGithubWorkerPrincipal(
    environ,
    options.expectedPrincipal,
  );
  if (expectedPrincipal !== null && "error" in expectedPrincipal && options.expectedPrincipal) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_MISSING_EXPECTED_PRINCIPAL,
      expectedPrincipal.error,
      withSource(source, { validationRepo: repo }),
    );
  }

  const userApi = runner(githubApiArgs("user", source.githubHost), environ);
  if (userApi.returncode !== 0) {
    if (isInstallationUserEndpointInapplicable(userApi)) {
      if (expectedPrincipal !== null) {
        return failClosedInstallationCredential(mode, runtimeMode, repo, source);
      }
      return validateInstallationAuth(mode, environ, runtimeMode, runner, repo, source);
    }
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_API_UNREACHABLE,
      formatUserApiFailureDetail(mode, userApi),
      withSource(source, { validationRepo: repo }),
    );
  }

  const login = parseLogin(userApi.stdout);
  if (login === null) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_PRINCIPAL_MISMATCH,
      "GitHub /user succeeded but returned no login",
      withSource(source, { validationRepo: repo }),
    );
  }

  if (expectedPrincipal !== null && "error" in expectedPrincipal) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_MISSING_EXPECTED_PRINCIPAL,
      expectedPrincipal.error,
      withSource(source, {
        login,
        validationRepo: repo,
      }),
    );
  }

  if (expectedPrincipal !== null) {
    if (!loginsMatch(expectedPrincipal.login, login)) {
      return emptyResult(
        mode,
        runtimeMode,
        FAILURE_PRINCIPAL_MISMATCH,
        `identity mismatch: expected ${expectedPrincipal.login}, observed ${login}`,
        withSource(source, { login, validationRepo: repo }),
      );
    }
  }

  const principal: ExpectedGithubWorkerPrincipal = { kind: PRINCIPAL_KIND_USER, login };
  return checkTargetRepoAccess(mode, runtimeMode, runner, environ, repo, login, principal, source);
}

function resolveSourceContext(
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions,
): SourceContext {
  const githubHost = resolveGithubHost({
    host: options.host,
    environ,
    gitRemoteUrl: options.gitRemoteUrl,
    readGitRemote: options.readGitRemote,
    cwd: options.cwd,
  });
  const applicable = findApplicableInjectedToken(environ, githubHost);
  return {
    githubHost,
    credentialSource: applicable !== null ? "injected-token" : "host-store",
    applicableTokenEnv: applicable?.name ?? null,
  };
}

export function validateInjectedTokenMode(
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions = {},
): GitHubAuthValidationResult {
  const runner = options.runGh ?? defaultRunGh;
  const runtimeMode = options.runtimeMode ?? null;
  const source = resolveSourceContext(environ, options);
  if (source.applicableTokenEnv === null) {
    const names = applicableTokenEnvNames(source.githubHost).join(", ");
    return emptyResult(
      GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      FAILURE_MISSING_INJECTED_TOKEN,
      `injected-token mode requires an applicable token for ${source.githubHost} (${names}); host gh credential store is not used`,
      withSource(source),
    );
  }

  return validateAfterAuth(
    GITHUB_AUTH_MODE_INJECTED_TOKEN,
    environ,
    options,
    runtimeMode,
    runner,
    source,
  );
}

export function validateHostGhMode(
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions = {},
): GitHubAuthValidationResult {
  const runner = options.runGh ?? defaultRunGh;
  const runtimeMode = options.runtimeMode ?? null;
  const source = resolveSourceContext(environ, options);
  return validateAfterAuth(GITHUB_AUTH_MODE_HOST_GH, environ, options, runtimeMode, runner, source);
}

export function validateGithubAuth(
  githubAuthMode: string,
  options: {
    environ?: NodeJS.ProcessEnv;
    runtimeReport?: RuntimeCapabilityReport | null;
    repo?: string;
    host?: string | null;
    runGh?: GhRunner;
    expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
    gitRemoteUrl?: string | null;
    readGitRemote?: GitRemoteReader;
    cwd?: string;
  } = {},
): GitHubAuthValidationResult {
  const env = options.environ ?? process.env;
  const runtimeMode = options.runtimeReport?.runtimeMode ?? null;

  if (!KNOWN_GITHUB_AUTH_MODES.has(githubAuthMode)) {
    return emptyResult(
      githubAuthMode,
      runtimeMode,
      FAILURE_INVALID_MODE,
      `unknown github_auth_mode ${pyRepr(githubAuthMode)}; expected one of ${pyRepr([...KNOWN_GITHUB_AUTH_MODES].sort())}`,
    );
  }

  const shared: GithubAuthValidationOptions = {
    repo: options.repo,
    host: options.host,
    runtimeMode,
    runGh: options.runGh,
    expectedPrincipal: options.expectedPrincipal,
    gitRemoteUrl: options.gitRemoteUrl,
    readGitRemote: options.readGitRemote,
    cwd: options.cwd,
  };

  if (githubAuthMode === GITHUB_AUTH_MODE_INJECTED_TOKEN) {
    return validateInjectedTokenMode(env, shared);
  }
  return validateHostGhMode(env, shared);
}

export function validateGithubAuthForWorker(
  githubAuthMode: string | null = null,
  options: {
    environ?: NodeJS.ProcessEnv;
    runtimeReport?: RuntimeCapabilityReport | null;
    repo?: string;
    host?: string | null;
    runGh?: GhRunner;
    expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
    gitRemoteUrl?: string | null;
    readGitRemote?: GitRemoteReader;
    cwd?: string;
  } = {},
): GitHubAuthValidationResult {
  const env = options.environ ?? process.env;
  const report = options.runtimeReport ?? getPlatformCapabilities();
  const host = resolveGithubHost({
    host: options.host,
    environ: env,
    gitRemoteUrl: options.gitRemoteUrl,
    readGitRemote: options.readGitRemote,
    cwd: options.cwd,
  });
  const mode = githubAuthMode ?? inferGithubAuthMode(env, { host });
  return validateGithubAuth(mode, {
    ...options,
    host,
    environ: env,
    runtimeReport: report,
  });
}

export function resultToDict(result: GitHubAuthValidationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    github_auth_mode: result.githubAuthMode,
    runtime_mode: result.runtimeMode,
    failure_kind: result.failureKind,
    detail: redactTokenShaped(result.detail),
    remediation: result.remediation === null ? null : redactTokenShaped(result.remediation),
    login: result.login !== null && containsTokenShapedText(result.login) ? null : result.login,
    principal_kind: result.principal?.kind ?? null,
    validation_repo: result.validationRepo,
    github_host: result.githubHost,
    credential_source: result.credentialSource,
    applicable_token_env: result.applicableTokenEnv,
    installation_authenticated: result.installationAuthenticated,
  };
}

export interface GitHubAuthModesCliArgs {
  githubAuthMode?: string | null;
  repo?: string;
  json?: boolean;
  runGh?: GhRunner;
  expectedLogin?: string;
  expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
}

function expectedPrincipalFromCliArgs(
  args: GitHubAuthModesCliArgs,
): ExpectedGithubWorkerPrincipal | { error: string } | undefined {
  if (args.expectedPrincipal !== undefined) {
    return args.expectedPrincipal ?? undefined;
  }
  const login = args.expectedLogin?.trim() ?? "";
  if (login.length > 0) {
    return { kind: PRINCIPAL_KIND_USER, login };
  }
  return undefined;
}

export function githubAuthModesMain(args: GitHubAuthModesCliArgs): number {
  const fromFlags = expectedPrincipalFromCliArgs(args);
  if (fromFlags !== undefined && "error" in fromFlags) {
    process.stderr.write(`${fromFlags.error}\n`);
    return 2;
  }
  const result = validateGithubAuthForWorker(args.githubAuthMode ?? null, {
    repo: args.repo,
    runGh: args.runGh,
    expectedPrincipal: fromFlags,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(resultToDict(result), null, 2)}\n`);
  } else {
    const status = result.ok ? "ok" : "failed";
    process.stdout.write(`github_auth_mode=${result.githubAuthMode} status=${status}\n`);
    process.stdout.write(`detail=${result.detail}\n`);
    if (result.remediation !== null) {
      process.stdout.write(`${result.remediation}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

export { probeRuntimeCapabilities };
