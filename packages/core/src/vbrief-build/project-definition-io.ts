import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { pythonJsonPretty } from "./json.js";
import type { JsonObject } from "./types.js";
import { ProjectDefinitionIOError } from "./types.js";

const mutationThreadLock = { held: false };

/** Setup override for a noncanonical PROJECT-DEFINITION path. */
export const ENV_PROJECT_PATH = "DEFT_PROJECT_PATH";

/**
 * Absolute path to the PROJECT-DEFINITION artifact. Layout-aware (#2302):
 * resolves `xbrief/PROJECT-DEFINITION.xbrief.json` on a migrated tree, else the
 * legacy `vbrief/PROJECT-DEFINITION.vbrief.json`, so loader not-found messages
 * name the path that actually applies to the project's layout.
 */
export function projectDefinitionPath(projectRoot: string): string {
  const override = process.env[ENV_PROJECT_PATH]?.trim();
  if (override) {
    const configuredPath = resolve(projectRoot, override);
    return existsSync(configuredPath) ? realpathSync(configuredPath) : configuredPath;
  }
  return resolveProjectDefinitionPath(resolve(projectRoot));
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function defaultSleep(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export interface MutationLockDeps {
  readonly sleepMs?: (ms: number) => void;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly writeOwner?: (fd: number, payload: string) => number;
  readonly renameLock?: (source: string, destination: string) => void;
  readonly beforeStaleReap?: (lockPath: string) => void;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string | null;
  readonly raw: string;
}

const LOCK_OWNER_ENTRY_RE = /^([1-9]\d*)-([a-f0-9]{32})$/;
const MALFORMED_LOCK_GRACE_MS = 1_000;
const RENAME_CONTENTION_CODES = new Set([
  "EACCES",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
]);

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

function parseLockOwner(raw: string): LockOwner | null {
  const normalized = raw.replace(/\0/g, "").trim();
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as { pid?: unknown; token?: unknown };
    if (
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      (typeof parsed.token === "string" || parsed.token === undefined)
    ) {
      return { pid: parsed.pid, token: parsed.token ?? null, raw };
    }
  } catch {
    /* fall through to legacy and partial metadata formats */
  }
  const partialJsonPid = /"pid"\s*:\s*([1-9]\d*)/.exec(normalized);
  const numericPid = /^([1-9]\d*)$/.exec(normalized);
  const pidText = partialJsonPid?.[1] ?? numericPid?.[1];
  if (pidText !== undefined) {
    const pid = Number(pidText);
    if (Number.isSafeInteger(pid) && pid > 0) {
      return { pid, token: null, raw };
    }
  }
  return null;
}

function readLegacyLockOwner(lockPath: string): LockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseLockOwner(raw);
}

function lockAgeMs(lockPath: string, now: () => number): number {
  try {
    return Math.max(0, now() - statSync(lockPath).mtimeMs);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Remove a legacy file sidecar. New acquisitions use a directory at the same
 * path, so a delayed `unlinkSync` can never remove a replacement lock on
 * POSIX or Windows (it fails on directories), closing the stale-reap ABA race.
 */
function reapLegacyFileLock(
  lockPath: string,
  owner: LockOwner | null,
  now: () => number,
  isProcessAlive: (pid: number) => boolean,
  beforeStaleReap: (lockPath: string) => void,
): boolean {
  if (owner !== null && isProcessAlive(owner.pid)) return false;
  if (owner === null && lockAgeMs(lockPath, now) < MALFORMED_LOCK_GRACE_MS) return false;
  beforeStaleReap(lockPath);
  try {
    unlinkSync(lockPath);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "EISDIR" || code === "EPERM" || code === "EACCES") {
      try {
        if (lstatSync(lockPath).isDirectory()) return false;
      } catch (inspectErr: unknown) {
        if ((inspectErr as NodeJS.ErrnoException).code === "ENOENT") return true;
      }
    }
    throw err;
  }
}

interface DirectoryLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly entryName: string;
}

function parseDirectoryLockOwnerEntry(entryName: string): DirectoryLockOwner | null {
  const match = LOCK_OWNER_ENTRY_RE.exec(entryName);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || match[2] === undefined) return null;
  return { pid, token: match[2], entryName };
}

function readDirectoryLockOwner(lockPath: string): DirectoryLockOwner | null {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (entries.length !== 1) return null;
  return parseDirectoryLockOwnerEntry(entries[0] ?? "");
}

/**
 * Reap a directory owner by deleting its unique owner entry first. Exactly one
 * contender can successfully unlink that entry; only that contender may remove
 * the directory. A later acquisition creates a new non-empty directory, which
 * a delayed `rmdirSync` cannot remove.
 */
function reapDirectoryLock(
  lockPath: string,
  owner: DirectoryLockOwner | null,
  now: () => number,
  isProcessAlive: (pid: number) => boolean,
  beforeStaleReap: (lockPath: string) => void,
): boolean {
  if (owner !== null) {
    if (isProcessAlive(owner.pid)) return false;
    beforeStaleReap(lockPath);
    try {
      unlinkSync(join(lockPath, owner.entryName));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  } else {
    let entries: string[];
    try {
      entries = readdirSync(lockPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    // A malformed directory may still contain a valid live owner plus debris.
    // Never recover it based on age alone while any identifiable owner lives.
    if (
      entries
        .map(parseDirectoryLockOwnerEntry)
        .some((entry) => entry !== null && isProcessAlive(entry.pid))
    ) {
      return false;
    }
    if (lockAgeMs(lockPath, now) < MALFORMED_LOCK_GRACE_MS) return false;
    beforeStaleReap(lockPath);
    try {
      entries = readdirSync(lockPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    if (
      entries
        .map(parseDirectoryLockOwnerEntry)
        .some((entry) => entry !== null && isProcessAlive(entry.pid))
    ) {
      return false;
    }
    for (const entry of entries) {
      try {
        unlinkSync(join(lockPath, entry));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  try {
    rmdirSync(lockPath);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw err;
  }
}

/** Serialise PROJECT-DEFINITION read-modify-write critical sections. */
export function projectDefinitionMutationLock<T>(
  projectRoot: string,
  fn: (artifactPath: string) => T,
  deps: MutationLockDeps = {},
): T {
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const writeOwner = deps.writeOwner ?? writeSync;
  const renameLock = deps.renameLock ?? renameSync;
  const beforeStaleReap = deps.beforeStaleReap ?? (() => undefined);
  // Derive the sidecar lock path from the layout-aware resolved PROJECT-DEFINITION
  // path (xbrief/ when migrated, else vbrief/) so the lock lives next to the real
  // artifact and every mutator sharing a project root contends on the same lock,
  // instead of the constant vbrief/ path which would strand a stray lock (#1260).
  const path = projectDefinitionPath(projectRoot);
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  if (mutationThreadLock.held) {
    throw new Error("project definition mutation lock is not reentrant");
  }
  mutationThreadLock.held = true;
  let fd: number | undefined;
  let ownerToken: string | undefined;
  let ownerEntryPath: string | undefined;
  let preparedEntryPath: string | undefined;
  let preparedLockPath: string | undefined;
  let acquired = false;
  try {
    // Fully materialize owner metadata in a unique sibling directory before
    // publishing the lock. Renaming the non-empty directory is the exclusive
    // claim: another contender cannot observe an empty/partial new lock, and a
    // stale reaper cannot remove a replacement because replacements are
    // non-empty at the instant they become visible.
    ownerToken = randomBytes(16).toString("hex");
    const ownerEntryName = `${process.pid}-${ownerToken}`;
    const preparedPath = `${lockPath}.claim-${ownerEntryName}`;
    preparedLockPath = preparedPath;
    preparedEntryPath = join(preparedPath, ownerEntryName);
    mkdirSync(preparedPath);
    const payload = `${JSON.stringify({ pid: process.pid, token: ownerToken })}\n`;
    try {
      fd = openSync(preparedEntryPath, "wx");
      const written = writeOwner(fd, payload);
      if (written !== Buffer.byteLength(payload)) {
        throw new Error("short write while recording project definition lock owner");
      }
      closeSync(fd);
      fd = undefined;
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
        fd = undefined;
      }
      try {
        unlinkSync(preparedEntryPath);
      } catch {
        /* best-effort */
      }
      try {
        rmdirSync(preparedPath);
      } catch {
        /* best-effort */
      }
      preparedEntryPath = undefined;
      preparedLockPath = undefined;
      throw err;
    }

    const deadline = now() + 30_000;
    while (true) {
      try {
        renameLock(preparedPath, lockPath);
        acquired = true;
        preparedLockPath = undefined;
        preparedEntryPath = undefined;
        ownerEntryPath = join(lockPath, ownerEntryName);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !RENAME_CONTENTION_CODES.has(code)) {
          throw err;
        }
        let lockStat: ReturnType<typeof lstatSync>;
        try {
          lockStat = lstatSync(lockPath);
        } catch (inspectErr: unknown) {
          if ((inspectErr as NodeJS.ErrnoException).code === "ENOENT") {
            // Windows may surface destination collisions as EACCES/EPERM, but
            // without a destination these are permission failures rather than
            // contention. Propagate them instead of spinning until timeout.
            if (code === "EACCES" || code === "EPERM") throw err;
            // The observed owner released between rename and inspection.
            continue;
          }
          throw inspectErr;
        }
        let reaped = false;
        if (lockStat.isDirectory()) {
          reaped = reapDirectoryLock(
            lockPath,
            readDirectoryLockOwner(lockPath),
            now,
            isProcessAlive,
            beforeStaleReap,
          );
        } else if (lockStat.isFile()) {
          reaped = reapLegacyFileLock(
            lockPath,
            readLegacyLockOwner(lockPath),
            now,
            isProcessAlive,
            beforeStaleReap,
          );
        }
        if (reaped) continue;
        if (now() > deadline) {
          throw new Error(`timed out waiting for project definition mutation lock at ${lockPath}`);
        }
        sleepMs(20);
      }
    }
    return fn(path);
  } finally {
    try {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
      if (acquired) {
        try {
          if (ownerEntryPath !== undefined && ownerToken !== undefined) {
            const current = readDirectoryLockOwner(lockPath);
            if (
              current?.token === ownerToken &&
              join(lockPath, current.entryName) === ownerEntryPath
            ) {
              unlinkSync(ownerEntryPath);
              rmdirSync(lockPath);
            }
          }
        } catch {
          /* best-effort */
        }
      } else {
        try {
          if (preparedEntryPath !== undefined) unlinkSync(preparedEntryPath);
        } catch {
          /* best-effort */
        }
        try {
          if (preparedLockPath !== undefined) rmdirSync(preparedLockPath);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      mutationThreadLock.held = false;
    }
  }
}

/** Read PROJECT-DEFINITION.vbrief.json and return ``(data, path)``. */
export function loadProjectDefinitionForMutation(projectRoot: string): [JsonObject, string] {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION not found at ${path}; run task triage:welcome / ` +
        "task triage:bootstrap to scaffold one first.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectDefinitionIOError(`Could not read PROJECT-DEFINITION at ${path}: ${msg}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectDefinitionIOError(`PROJECT-DEFINITION at ${path} is not valid JSON: ${msg}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION at ${path} top-level value is not a JSON object`,
    );
  }
  return [structuredClone(data) as JsonObject, path];
}

/** Atomically write ``data`` to ``path`` as pretty-printed JSON. */
export function atomicWriteProjectDefinition(path: string, data: JsonObject): void {
  // #2980 wave C: product write sink routes through containedWrite (temp under parent).
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload = pythonJsonPretty(data).replace(/\n$/, "");
  const body = payload.endsWith("\n") ? payload : `${payload}\n`;
  const tmpName = `${basename(path)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmp = join(dir, tmpName);
  try {
    containedWrite({
      root: resolve(dir),
      target: tmpName,
      data: body,
      mode: "create",
    });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
