/**
 * Durable Cursor planning-choice store (#4973 clauses 5–8).
 * Result-typed: no throw/reject/abort sites.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  CursorPlanChoiceDeps,
  CursorPlanChoiceIdentity,
  CursorPlanChoiceRecord,
  CursorPlanChoiceStoreResult,
  PlanChoicePending,
  PlanChoiceSelected,
} from "./types.js";
import {
  CURSOR_PLAN_CHOICE_HOST,
  CURSOR_PLAN_CHOICE_LIMITS,
  CURSOR_PLAN_CHOICE_QUESTION_VERSION,
  CURSOR_PLAN_CHOICE_REL_SEGMENTS,
  CURSOR_PLAN_CHOICE_SCHEMA,
} from "./types.js";

const HEX64 = /^[a-f0-9]{64}$/;

export function planChoiceStoreRoot(deps: CursorPlanChoiceDeps): string {
  return resolve(deps.configDir, ...CURSOR_PLAN_CHOICE_REL_SEGMENTS);
}

export function planChoiceRecordPath(
  deps: CursorPlanChoiceDeps,
  identity: CursorPlanChoiceIdentity,
): string {
  return join(
    planChoiceStoreRoot(deps),
    identity.workspaceHash,
    `${identity.conversationHash}.json`,
  );
}

function fail(
  code: "lock-busy" | "lock-ambiguous" | "storage-failure" | "unsafe-path" | "invalid-schema",
  message: string,
): { readonly ok: false; readonly code: typeof code; readonly message: string } {
  return { ok: false, code, message };
}

function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return true;
}

function inspectNode(
  path: string,
  expect: "dir" | "file",
  deps: CursorPlanChoiceDeps,
): CursorPlanChoiceStoreResult<void> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: true, value: undefined };
  }
  if (st.isSymbolicLink()) {
    return fail("unsafe-path", `refusing symlink at ${path}`);
  }
  if (expect === "dir" && !st.isDirectory()) {
    return fail("unsafe-path", `refusing non-directory at ${path}`);
  }
  if (expect === "file" && !st.isFile()) {
    return fail("unsafe-path", `refusing non-regular file at ${path}`);
  }
  if (deps.uid !== null && typeof st.uid === "number" && st.uid !== deps.uid) {
    return fail("unsafe-path", `refusing foreign ownership at ${path}`);
  }
  return { ok: true, value: undefined };
}

function ensureDir(path: string, deps: CursorPlanChoiceDeps): CursorPlanChoiceStoreResult<void> {
  const root = planChoiceStoreRoot(deps);
  if (!contained(dirname(root), path) && resolve(path) !== resolve(root)) {
    if (!contained(root, path) && resolve(path) !== resolve(root)) {
      return fail("unsafe-path", "path escape");
    }
  }
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { recursive: true, mode: CURSOR_PLAN_CHOICE_LIMITS.dirMode });
    } catch {
      return fail("storage-failure", `could not create directory ${path}`);
    }
  }
  const inspected = inspectNode(path, "dir", deps);
  if (!inspected.ok) return inspected;
  try {
    chmodSync(path, CURSOR_PLAN_CHOICE_LIMITS.dirMode);
  } catch {
    /* win32 may ignore mode */
  }
  return { ok: true, value: undefined };
}

function fsyncPath(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* directory fsync is best-effort on win32 */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseRecord(raw: string): CursorPlanChoiceStoreResult<CursorPlanChoiceRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail("invalid-schema", "record is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("invalid-schema", "record is not an object");
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== CURSOR_PLAN_CHOICE_SCHEMA) {
    return fail("invalid-schema", "unsupported schema");
  }
  if (rec.host !== CURSOR_PLAN_CHOICE_HOST) {
    return fail("invalid-schema", "unsupported host");
  }
  if (typeof rec.questionVersion !== "string" || typeof rec.workspaceRoot !== "string") {
    return fail("invalid-schema", "missing identity fields");
  }
  if (typeof rec.conversationId !== "string") {
    return fail("invalid-schema", "missing conversationId");
  }
  if (typeof rec.workspaceHash !== "string" || typeof rec.conversationHash !== "string") {
    return fail("invalid-schema", "missing hashes");
  }
  if (rec.status !== "pending" && rec.status !== "selected") {
    return fail("invalid-schema", "invalid status");
  }
  return { ok: true, value: rec as unknown as CursorPlanChoiceRecord };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isPendingLive(pending: PlanChoicePending | null, nowMs: number): boolean {
  if (pending === null) return false;
  const expires = Date.parse(pending.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

export function isSelectedLive(selected: PlanChoiceSelected | null, nowMs: number): boolean {
  if (selected === null) return false;
  if (selected.questionVersion !== CURSOR_PLAN_CHOICE_QUESTION_VERSION) return false;
  const last = Date.parse(selected.lastUsedAt);
  return Number.isFinite(last) && nowMs - last <= CURSOR_PLAN_CHOICE_LIMITS.selectedIdleMs;
}

type LockHeld = { readonly lockPath: string; readonly fd: number };

function acquireLock(
  lockPath: string,
  deps: CursorPlanChoiceDeps,
): CursorPlanChoiceStoreResult<LockHeld> {
  let waited = 0;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, Buffer.from(`${deps.pid}\n${deps.now()}\n`));
      try {
        fsyncSync(fd);
      } catch {
        /* ignore */
      }
      return { ok: true, value: { lockPath, fd } };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return fail("storage-failure", `lock open failed at ${lockPath}`);
      }
      let ownerPid: number | null = null;
      try {
        const body = readFileSync(lockPath, "utf8");
        const parsed = Number(body.split(/\r?\n/)[0]);
        ownerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      } catch {
        ownerPid = null;
      }
      if (ownerPid !== null && !deps.processExists(ownerPid)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          return fail("lock-ambiguous", "could not reclaim a dead lock owner");
        }
      }
      if (ownerPid === null) {
        return fail("lock-ambiguous", "lock owner cannot be proven");
      }
      waited += CURSOR_PLAN_CHOICE_LIMITS.lockSleepMs;
      if (waited >= CURSOR_PLAN_CHOICE_LIMITS.lockWaitMs) {
        return fail("lock-busy", "timed out waiting for planning-choice lock");
      }
      deps.sleepMs(CURSOR_PLAN_CHOICE_LIMITS.lockSleepMs);
    }
  }
}

function releaseLock(held: LockHeld): void {
  try {
    closeSync(held.fd);
  } catch {
    /* already closed */
  }
  try {
    unlinkSync(held.lockPath);
  } catch {
    /* already gone */
  }
}

function atomicWriteFile(
  path: string,
  body: string,
  deps: CursorPlanChoiceDeps,
): CursorPlanChoiceStoreResult<void> {
  const dir = dirname(path);
  const tmp = join(dir, `${deps.pid}.${deps.now()}.tmp`);
  if (!contained(planChoiceStoreRoot(deps), path) || !contained(planChoiceStoreRoot(deps), tmp)) {
    return fail("unsafe-path", "path escape");
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx");
    writeSync(fd, Buffer.from(body, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, CURSOR_PLAN_CHOICE_LIMITS.fileMode);
    renameSync(tmp, path);
    fsyncPath(dir);
    return { ok: true, value: undefined };
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return fail("storage-failure", `atomic write failed for ${path}`);
  }
}

function cleanupWorkspace(deps: CursorPlanChoiceDeps, workspaceHash: string): void {
  const dir = join(planChoiceStoreRoot(deps), workspaceHash);
  if (!existsSync(dir)) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = deps.now();
  let scanned = 0;
  for (const name of names) {
    if (scanned >= CURSOR_PLAN_CHOICE_LIMITS.cleanupScanMax) return;
    if (!name.endsWith(".json")) continue;
    scanned += 1;
    const path = join(dir, name);
    const inspected = inspectNode(path, "file", deps);
    if (!inspected.ok) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseRecord(raw);
    if (!parsed.ok) continue;
    const livePending = isPendingLive(parsed.value.pending, now);
    const liveSelected = isSelectedLive(parsed.value.selected, now);
    if (livePending || liveSelected) continue;
    try {
      unlinkSync(path);
    } catch {
      /* never count deletion as consent */
    }
  }
}

export function withPlanChoiceRecord(
  deps: CursorPlanChoiceDeps,
  identity: CursorPlanChoiceIdentity,
  mutate: (
    current: CursorPlanChoiceRecord | null,
  ) => CursorPlanChoiceStoreResult<CursorPlanChoiceRecord | null>,
): CursorPlanChoiceStoreResult<CursorPlanChoiceRecord | null> {
  if (!HEX64.test(identity.workspaceHash) || !HEX64.test(identity.conversationHash)) {
    return fail("unsafe-path", "identity hash is not a sha256 hex digest");
  }
  const root = planChoiceStoreRoot(deps);
  const choiceRoot = join(deps.configDir, "runtime", "cursor-plan-choice");
  const wsDir = join(root, identity.workspaceHash);
  const recordPath = planChoiceRecordPath(deps, identity);
  const lockPath = `${recordPath}.lock`;
  try {
    mkdirSync(root, { recursive: true, mode: CURSOR_PLAN_CHOICE_LIMITS.dirMode });
  } catch {
    return fail("storage-failure", "could not create planning-choice store");
  }
  for (const dir of [choiceRoot, root, wsDir]) {
    const ensured = ensureDir(dir, deps);
    if (!ensured.ok) return ensured;
  }
  const inspectedFile = inspectNode(recordPath, "file", deps);
  if (!inspectedFile.ok && existsSync(recordPath)) return inspectedFile;
  const lock = acquireLock(lockPath, deps);
  if (!lock.ok) return lock;
  try {
    cleanupWorkspace(deps, identity.workspaceHash);
    let current: CursorPlanChoiceRecord | null = null;
    if (existsSync(recordPath)) {
      const inspected = inspectNode(recordPath, "file", deps);
      if (!inspected.ok) return inspected;
      let raw: string;
      try {
        raw = readFileSync(recordPath, "utf8");
      } catch {
        return fail("storage-failure", "could not read planning-choice record");
      }
      const parsed = parseRecord(raw);
      if (!parsed.ok) return parsed;
      current = parsed.value;
    }
    const next = mutate(current);
    if (!next.ok) return next;
    if (next.value === null) {
      if (existsSync(recordPath)) {
        try {
          unlinkSync(recordPath);
        } catch {
          return fail("storage-failure", "could not remove planning-choice record");
        }
      }
      return { ok: true, value: null };
    }
    const written = atomicWriteFile(recordPath, `${JSON.stringify(next.value, null, 2)}\n`, deps);
    if (!written.ok) return written;
    return { ok: true, value: next.value };
  } finally {
    releaseLock(lock.value);
  }
}

export function newPending(deps: CursorPlanChoiceDeps): PlanChoicePending {
  const token = deps.randomBytes(CURSOR_PLAN_CHOICE_LIMITS.tokenBytes).toString("hex");
  const created = deps.now();
  return {
    token,
    createdAt: iso(created),
    expiresAt: iso(created + CURSOR_PLAN_CHOICE_LIMITS.pendingTtlMs),
  };
}

export function emptyPendingRecord(
  identity: CursorPlanChoiceIdentity,
  pending: PlanChoicePending,
): CursorPlanChoiceRecord {
  return {
    schema: CURSOR_PLAN_CHOICE_SCHEMA,
    questionVersion: CURSOR_PLAN_CHOICE_QUESTION_VERSION,
    host: CURSOR_PLAN_CHOICE_HOST,
    workspaceRoot: identity.workspaceRoot,
    conversationId: identity.conversationId,
    workspaceHash: identity.workspaceHash,
    conversationHash: identity.conversationHash,
    status: "pending",
    pending,
    selected: null,
  };
}
