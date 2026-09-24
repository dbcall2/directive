/**
 * Cooperative local worker GitHub-auth assignment registry (#3663).
 *
 * PREP writes a non-secret per-destination record under the Git common
 * directory. The worker reads it from the current worktree. This is not
 * protection against a same-user process deleting the files.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedRemove, containedWrite } from "../fs/contained-write.js";
import {
  type ExpectedGithubWorkerPrincipal,
  GITHUB_AUTH_MODE_HOST_GH,
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  PRINCIPAL_KIND_USER,
} from "../intake/github-auth-modes.js";
import { defaultGitRunner, type GitRunner, gitCommonDir } from "../session/git.js";

export const WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION = Number.parseInt("1", 10);
export const WORKER_AUTH_STORE_DIR = "deft-worker-auth";
export const WORKER_AUTH_INDEX_NAME = "index.json";
export const WORKER_AUTH_LOCK_NAME = "index.lock";
export const ENV_WORKER_CREDENTIAL_DELIVERY_ID = "DEFT_WORKER_CREDENTIAL_DELIVERY_ID";

export const FAILURE_MISSING_ASSIGNMENT = "missing_assignment";
export const FAILURE_MALFORMED_ASSIGNMENT = "malformed_assignment";
export const FAILURE_ORPHAN_ASSIGNMENT = "orphan_assignment";
export const FAILURE_DUPLICATE_ASSIGNMENT = "duplicate_assignment";
export const FAILURE_REGISTRY_CORRUPTION = "registry_corruption";
export const FAILURE_MISSING_DELIVERY = "missing_delivery";
export const FAILURE_DELIVERY_MISMATCH = "delivery_mismatch";
export const FAILURE_RUNTIME_MODE_DENIED = "runtime_mode_denied";
export const FAILURE_AMBIENT_TOKEN_CONFLICT = "ambient_token_conflict";
export const FAILURE_MISSING_WORKER_AUTH_MODE = "missing_worker_github_auth_mode";
export const FAILURE_MISSING_WORKER_LOGIN = "missing_expected_worker_login";

export interface WorkerAuthAssignment {
  readonly schema_version: number;
  readonly dispatch_id: string;
  readonly story_id: string;
  readonly worktree_path: string;
  readonly github_auth_mode:
    | typeof GITHUB_AUTH_MODE_HOST_GH
    | typeof GITHUB_AUTH_MODE_INJECTED_TOKEN;
  readonly expected_principal: ExpectedGithubWorkerPrincipal;
  readonly credential_delivery_id: string | null;
}

export interface WorkerAuthIndexEntry {
  readonly worktree_path: string;
  readonly record_name: string;
}

export interface WorkerAuthIndex {
  readonly schema_version: number;
  readonly entries: readonly WorkerAuthIndexEntry[];
}

export interface WriteWorkerAuthAssignmentInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly dispatchId: string;
  readonly storyId: string;
  readonly githubAuthMode: string;
  readonly expectedPrincipal: ExpectedGithubWorkerPrincipal;
  readonly credentialDeliveryId: string | null;
  readonly runGit?: GitRunner;
}

export type WorkerAuthAssignmentError = {
  readonly ok: false;
  readonly failureKind: string;
  readonly detail: string;
  readonly dispatchId: string | null;
  readonly expectedLogin: string | null;
  readonly observedLogin: string | null;
};

export type WriteWorkerAuthAssignmentResult =
  | { readonly ok: true; readonly assignment: WorkerAuthAssignment; readonly commonDir: string }
  | WorkerAuthAssignmentError;

export type ReadWorkerAuthAssignmentResult =
  | {
      readonly ok: true;
      readonly assignment: WorkerAuthAssignment | null;
      readonly commonDir: string | null;
    }
  | WorkerAuthAssignmentError;

function fail(
  failureKind: string,
  detail: string,
  extras: {
    dispatchId?: string | null;
    expectedLogin?: string | null;
    observedLogin?: string | null;
  } = {},
): WorkerAuthAssignmentError {
  return {
    ok: false,
    failureKind,
    detail,
    dispatchId: extras.dispatchId ?? null,
    expectedLogin: extras.expectedLogin ?? null,
    observedLogin: extras.observedLogin ?? null,
  };
}

export function mintCredentialDeliveryId(): string {
  return randomUUID();
}

export function canonicalWorktreePath(worktreePath: string): string {
  const abs = resolve(worktreePath);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function workerAuthRecordName(canonicalPath: string): string {
  return `${createHash("sha256").update(canonicalPath).digest("hex")}.json`;
}

export function resolveWorkerAuthCommonDir(
  startDir: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  return gitCommonDir(startDir, runGit);
}

function indexPathRel(): string {
  return join(WORKER_AUTH_STORE_DIR, WORKER_AUTH_INDEX_NAME);
}

function recordPathRel(recordName: string): string {
  return join(WORKER_AUTH_STORE_DIR, recordName);
}

function lockPathRel(): string {
  return join(WORKER_AUTH_STORE_DIR, WORKER_AUTH_LOCK_NAME);
}

function parsePrincipal(value: unknown): ExpectedGithubWorkerPrincipal | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.kind !== PRINCIPAL_KIND_USER) {
    return null;
  }
  if (typeof rec.login !== "string" || rec.login.trim().length === 0) {
    return null;
  }
  return { kind: PRINCIPAL_KIND_USER, login: rec.login.trim() };
}

function parseAssignment(value: unknown): WorkerAuthAssignment | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.schema_version !== WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION) {
    return null;
  }
  if (typeof rec.dispatch_id !== "string" || rec.dispatch_id.trim().length === 0) {
    return null;
  }
  if (typeof rec.story_id !== "string" || rec.story_id.trim().length === 0) {
    return null;
  }
  if (typeof rec.worktree_path !== "string" || rec.worktree_path.trim().length === 0) {
    return null;
  }
  if (
    rec.github_auth_mode !== GITHUB_AUTH_MODE_HOST_GH &&
    rec.github_auth_mode !== GITHUB_AUTH_MODE_INJECTED_TOKEN
  ) {
    return null;
  }
  const principal = parsePrincipal(rec.expected_principal);
  if (principal === null) {
    return null;
  }
  if (rec.credential_delivery_id !== null && typeof rec.credential_delivery_id !== "string") {
    return null;
  }
  if (
    typeof rec.credential_delivery_id === "string" &&
    rec.credential_delivery_id.trim().length === 0
  ) {
    return null;
  }
  return {
    schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION,
    dispatch_id: rec.dispatch_id.trim(),
    story_id: rec.story_id.trim(),
    worktree_path: rec.worktree_path,
    github_auth_mode: rec.github_auth_mode,
    expected_principal: principal,
    credential_delivery_id: rec.credential_delivery_id,
  };
}

function parseIndex(value: unknown): WorkerAuthIndex | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.schema_version !== WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(rec.entries)) {
    return null;
  }
  const entries: WorkerAuthIndexEntry[] = [];
  for (const raw of rec.entries) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.worktree_path !== "string" || entry.worktree_path.trim().length === 0) {
      return null;
    }
    if (typeof entry.record_name !== "string" || !/^[0-9a-f]{64}\.json$/i.test(entry.record_name)) {
      return null;
    }
    entries.push({ worktree_path: entry.worktree_path, record_name: entry.record_name });
  }
  return { schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION, entries };
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function loadIndex(commonDir: string): WorkerAuthIndex | "missing" | "corrupt" {
  const abs = join(commonDir, indexPathRel());
  if (!existsSync(abs)) {
    return "missing";
  }
  const raw = readJsonFile(abs);
  if (raw === undefined) {
    return "corrupt";
  }
  const parsed = parseIndex(raw);
  return parsed === null ? "corrupt" : parsed;
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function withLock(
  commonDir: string,
  body: () => WriteWorkerAuthAssignmentResult,
): WriteWorkerAuthAssignmentResult {
  try {
    containedWrite({
      root: commonDir,
      target: lockPathRel(),
      data: "locked\n",
      mode: "create",
    });
  } catch (err: unknown) {
    if (err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS") {
      return fail(FAILURE_REGISTRY_CORRUPTION, "worker auth registry is locked");
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(FAILURE_REGISTRY_CORRUPTION, `worker auth registry lock failed: ${message}`);
  }
  try {
    return body();
  } finally {
    containedRemove({ root: commonDir, target: lockPathRel() });
  }
}

function persistIndexAndRecord(
  commonDir: string,
  assignment: WorkerAuthAssignment,
  recordName: string,
): WorkerAuthAssignmentError | null {
  const indexState = loadIndex(commonDir);
  if (indexState === "corrupt") {
    return fail(FAILURE_REGISTRY_CORRUPTION, "worker auth index is unreadable or malformed");
  }
  const existing = indexState === "missing" ? [] : [...indexState.entries];
  const nextEntries: WorkerAuthIndexEntry[] = [];
  let seen = false;
  for (const entry of existing) {
    if (samePath(entry.worktree_path, assignment.worktree_path)) {
      if (seen) {
        return fail(
          FAILURE_DUPLICATE_ASSIGNMENT,
          `duplicate worker auth index entries for ${assignment.worktree_path}`,
          {
            dispatchId: assignment.dispatch_id,
            expectedLogin: assignment.expected_principal.login,
          },
        );
      }
      seen = true;
      nextEntries.push({ worktree_path: assignment.worktree_path, record_name: recordName });
    } else {
      nextEntries.push(entry);
    }
  }
  if (!seen) {
    nextEntries.push({ worktree_path: assignment.worktree_path, record_name: recordName });
  }
  const index: WorkerAuthIndex = {
    schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION,
    entries: nextEntries,
  };
  try {
    containedWrite({
      root: commonDir,
      target: recordPathRel(recordName),
      data: `${JSON.stringify(assignment, null, 2)}\n`,
      mode: "replace",
    });
    containedWrite({
      root: commonDir,
      target: indexPathRel(),
      data: `${JSON.stringify(index, null, 2)}\n`,
      mode: "replace",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(FAILURE_REGISTRY_CORRUPTION, `worker auth registry write failed: ${message}`, {
      dispatchId: assignment.dispatch_id,
    });
  }
  return null;
}

function recordsAgree(
  commonDir: string,
  assignment: WorkerAuthAssignment,
  recordName: string,
): boolean {
  const indexState = loadIndex(commonDir);
  if (indexState === "missing" || indexState === "corrupt") {
    return false;
  }
  const matches = indexState.entries.filter((entry) =>
    samePath(entry.worktree_path, assignment.worktree_path),
  );
  if (matches.length !== 1) {
    return false;
  }
  if (matches[0]?.record_name !== recordName) {
    return false;
  }
  const raw = readJsonFile(join(commonDir, recordPathRel(recordName)));
  const parsed = parseAssignment(raw);
  if (parsed === null) {
    return false;
  }
  return (
    parsed.dispatch_id === assignment.dispatch_id &&
    parsed.story_id === assignment.story_id &&
    samePath(parsed.worktree_path, assignment.worktree_path) &&
    parsed.github_auth_mode === assignment.github_auth_mode &&
    parsed.expected_principal.login === assignment.expected_principal.login &&
    parsed.credential_delivery_id === assignment.credential_delivery_id
  );
}

export function writeWorkerAuthAssignment(
  input: WriteWorkerAuthAssignmentInput,
): WriteWorkerAuthAssignmentResult {
  if (
    input.githubAuthMode !== GITHUB_AUTH_MODE_HOST_GH &&
    input.githubAuthMode !== GITHUB_AUTH_MODE_INJECTED_TOKEN
  ) {
    return fail(
      FAILURE_MISSING_WORKER_AUTH_MODE,
      `unknown --worker-github-auth-mode ${JSON.stringify(input.githubAuthMode)}; expected host-gh|injected-token`,
    );
  }
  const login = input.expectedPrincipal.login.trim();
  if (input.expectedPrincipal.kind !== PRINCIPAL_KIND_USER || login.length === 0) {
    return fail(
      FAILURE_MISSING_WORKER_LOGIN,
      "--expected-worker-login requires a non-empty user login",
    );
  }
  const start = existsSync(input.worktreePath) ? input.worktreePath : input.projectRoot;
  const commonDir = resolveWorkerAuthCommonDir(start, input.runGit ?? defaultGitRunner);
  if (commonDir === null) {
    return fail(
      FAILURE_REGISTRY_CORRUPTION,
      "cannot resolve Git common directory for worker auth assignment; dest must be a local linked worktree",
    );
  }
  const canonical = canonicalWorktreePath(input.worktreePath);
  const recordName = workerAuthRecordName(canonical);
  const assignment: WorkerAuthAssignment = {
    schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION,
    dispatch_id: input.dispatchId.trim(),
    story_id: input.storyId.trim(),
    worktree_path: canonical,
    github_auth_mode: input.githubAuthMode,
    expected_principal: { kind: PRINCIPAL_KIND_USER, login },
    credential_delivery_id: input.credentialDeliveryId,
  };
  if (assignment.dispatch_id.length === 0 || assignment.story_id.length === 0) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      "worker auth assignment requires dispatch_id and story_id",
    );
  }
  return withLock(commonDir, () => {
    const persistErr = persistIndexAndRecord(commonDir, assignment, recordName);
    if (persistErr !== null) {
      return persistErr;
    }
    if (!recordsAgree(commonDir, assignment, recordName)) {
      return fail(
        FAILURE_REGISTRY_CORRUPTION,
        "worker auth record and index do not agree after write",
        {
          dispatchId: assignment.dispatch_id,
        },
      );
    }
    return { ok: true, assignment, commonDir };
  });
}

export function readWorkerAuthAssignment(
  cwd: string = process.cwd(),
  runGit: GitRunner = defaultGitRunner,
): ReadWorkerAuthAssignmentResult {
  const commonDir = resolveWorkerAuthCommonDir(cwd, runGit);
  if (commonDir === null) {
    return { ok: true, assignment: null, commonDir: null };
  }
  const canonical = canonicalWorktreePath(cwd);
  const recordName = workerAuthRecordName(canonical);
  const recordAbs = join(commonDir, recordPathRel(recordName));
  const indexState = loadIndex(commonDir);
  if (indexState === "corrupt") {
    return fail(FAILURE_REGISTRY_CORRUPTION, "worker auth index is unreadable or malformed");
  }
  const registered =
    indexState === "missing"
      ? []
      : indexState.entries.filter((entry) => samePath(entry.worktree_path, canonical));
  const recordExists = existsSync(recordAbs);

  if (registered.length === 0 && !recordExists) {
    return { ok: true, assignment: null, commonDir };
  }
  if (registered.length === 0 && recordExists) {
    return fail(
      FAILURE_ORPHAN_ASSIGNMENT,
      `worker auth assignment exists without index registration for ${canonical}`,
    );
  }
  if (registered.length > 1) {
    return fail(
      FAILURE_DUPLICATE_ASSIGNMENT,
      `duplicate worker auth index entries for ${canonical}`,
    );
  }
  const indexRecordName = registered[0]?.record_name;
  if (indexRecordName !== recordName) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth index record name does not match dest hash for ${canonical}`,
    );
  }
  if (!recordExists) {
    return fail(
      FAILURE_MISSING_ASSIGNMENT,
      `registered worker dest ${canonical} is missing its assignment record`,
    );
  }
  const raw = readJsonFile(recordAbs);
  if (raw === undefined) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth assignment is unreadable for ${canonical}`,
    );
  }
  const parsed = parseAssignment(raw);
  if (parsed === null) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth assignment is malformed for ${canonical}`,
    );
  }
  if (!samePath(parsed.worktree_path, canonical)) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth assignment worktree_path does not match dest ${canonical}`,
      { dispatchId: parsed.dispatch_id, expectedLogin: parsed.expected_principal.login },
    );
  }
  return { ok: true, assignment: parsed, commonDir };
}

export function observedCredentialDeliveryId(environ: NodeJS.ProcessEnv): string | null {
  const value = environ[ENV_WORKER_CREDENTIAL_DELIVERY_ID]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function workerAuthStoreDir(commonDir: string): string {
  return join(commonDir, WORKER_AUTH_STORE_DIR);
}
