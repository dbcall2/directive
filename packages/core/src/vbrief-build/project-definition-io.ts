import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
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
}

interface LockOwner {
  readonly pid: number;
  readonly token: string | null;
  readonly raw: string;
}

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

function readLockOwner(lockPath: string): LockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      (typeof parsed.token === "string" || parsed.token === undefined)
    ) {
      return { pid: parsed.pid, token: parsed.token ?? null, raw };
    }
  } catch {
    /* fall through to the legacy numeric-PID format */
  }
  const pid = Number(raw.trim());
  if (Number.isSafeInteger(pid) && pid > 0) {
    return { pid, token: null, raw };
  }
  return null;
}

function reapDeadOwner(lockPath: string, owner: LockOwner): boolean {
  let current: string;
  try {
    current = readFileSync(lockPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if (current !== owner.raw) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/** Serialise PROJECT-DEFINITION read-modify-write critical sections. */
export function projectDefinitionMutationLock<T>(
  projectRoot: string,
  fn: () => T,
  deps: MutationLockDeps = {},
): T {
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
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
  try {
    const deadline = now() + 30_000;
    while (true) {
      try {
        // `wx` maps to O_CREAT|O_EXCL, so only one process can acquire this
        // sidecar. The prior `a+` open serialized threads but allowed separate
        // CLI processes to enter the same read-modify-write section (#3609).
        fd = openSync(lockPath, "wx");
        ownerToken = randomBytes(16).toString("hex");
        writeSync(fd, `${JSON.stringify({ pid: process.pid, token: ownerToken })}\n`);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        const owner = readLockOwner(lockPath);
        if (owner === null) {
          if (now() > deadline) {
            throw new Error(
              `timed out waiting for project definition mutation lock at ${lockPath}`,
            );
          }
          sleepMs(20);
          continue;
        }
        if (!isProcessAlive(owner.pid) && reapDeadOwner(lockPath, owner)) {
          continue;
        }
        if (now() > deadline) {
          throw new Error(`timed out waiting for project definition mutation lock at ${lockPath}`);
        }
        sleepMs(20);
      }
    }
    return fn();
  } finally {
    try {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } finally {
          try {
            const current = readLockOwner(lockPath);
            if (ownerToken === undefined || current?.token === ownerToken) {
              unlinkSync(lockPath);
            }
          } catch {
            /* best-effort */
          }
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
