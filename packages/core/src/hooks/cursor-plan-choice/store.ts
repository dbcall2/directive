/**
 * Durable Cursor planning-choice store (#4973 clauses 5–8).
 * Result-typed: no throw/reject/abort sites.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedChmod,
  containedRemove,
  containedRename,
  containedWrite,
} from "../../fs/contained-write.js";
import type {
  CursorPlanChoiceDeps,
  CursorPlanChoiceIdentity,
  CursorPlanChoiceRecord,
  CursorPlanChoiceStoreError,
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

type LockHeld = {
  readonly lockPath: string;
  readonly token: string;
  readonly pid: number;
};

function containedFail(err: unknown, fallback: string): CursorPlanChoiceStoreError {
  if (err instanceof ContainedWriteError) {
    if (
      err.code === ContainedWriteErrorCode.ESCAPE ||
      err.code === ContainedWriteErrorCode.SYMLINK
    ) {
      return fail("unsafe-path", err.message);
    }
  }
  return fail("storage-failure", fallback);
}

function writeExclusive(
  root: string,
  path: string,
  data: string,
): "created" | "exists" | CursorPlanChoiceStoreError {
  try {
    containedWrite({
      root,
      target: path,
      data,
      mode: "create",
      mutation: false,
    });
    try {
      containedChmod({
        root,
        target: path,
        mode: CURSOR_PLAN_CHOICE_LIMITS.fileMode,
        mutation: false,
      });
    } catch {
      /* win32 may ignore mode */
    }
    return "created";
  } catch (err) {
    if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
      return "exists";
    }
    return containedFail(err, `lock open failed at ${path}`);
  }
}

function removeContained(root: string, path: string): boolean {
  try {
    containedRemove({ root, target: path, mutation: false });
    return true;
  } catch {
    return false;
  }
}

function readLockOwner(lockPath: string): { pid: number | null; token: string | null } {
  try {
    const body = readFileSync(lockPath, "utf8");
    const lines = body.split(/\r?\n/);
    const parsed = Number(lines[0]);
    const pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    const tokenLine = lines[2] ?? "";
    const token = tokenLine.length > 0 ? tokenLine : null;
    return { pid, token };
  } catch {
    return { pid: null, token: null };
  }
}

function ownerlessLockStale(lockPath: string, nowMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = lstatSync(lockPath).mtimeMs;
  } catch {
    return true;
  }
  if (!Number.isFinite(mtimeMs)) return true;
  const injectedAge = nowMs - mtimeMs;
  if (injectedAge >= CURSOR_PLAN_CHOICE_LIMITS.lockWaitMs) return true;
  const wallAge = Date.now() - mtimeMs;
  return wallAge >= CURSOR_PLAN_CHOICE_LIMITS.lockWaitMs;
}

function lockReclaimable(
  ownerPid: number | null,
  lockPath: string,
  deps: CursorPlanChoiceDeps,
  waitExhausted: boolean,
): boolean {
  if (ownerPid !== null) return !deps.processExists(ownerPid);
  return waitExhausted || ownerlessLockStale(lockPath, deps.now());
}

function lockBody(deps: CursorPlanChoiceDeps, token: string): string {
  return `${deps.pid}\n${deps.now()}\n${token}\n`;
}

function acquireReclaimTicket(
  root: string,
  reclaimPath: string,
  body: string,
  deps: CursorPlanChoiceDeps,
): CursorPlanChoiceStoreResult<void> {
  const created = writeExclusive(root, reclaimPath, body);
  if (created === "created") return { ok: true, value: undefined };
  if (created !== "exists") return created;
  const owner = readLockOwner(reclaimPath);
  if (owner.pid !== null && deps.processExists(owner.pid)) {
    return fail("lock-busy", "timed out waiting for planning-choice lock");
  }
  if (owner.pid === null && !ownerlessLockStale(reclaimPath, deps.now())) {
    return fail("lock-busy", "timed out waiting for planning-choice lock");
  }
  if (!removeContained(root, reclaimPath)) {
    return fail("lock-ambiguous", "could not reclaim a dead lock owner");
  }
  const retry = writeExclusive(root, reclaimPath, body);
  if (retry === "created") return { ok: true, value: undefined };
  if (retry === "exists") {
    return fail("lock-busy", "timed out waiting for planning-choice lock");
  }
  return retry;
}

function acquireLock(
  lockPath: string,
  deps: CursorPlanChoiceDeps,
): CursorPlanChoiceStoreResult<LockHeld> {
  const root = deps.configDir;
  const reclaimPath = `${lockPath}.reclaim`;
  const token = deps.randomBytes(CURSOR_PLAN_CHOICE_LIMITS.tokenBytes).toString("hex");
  const body = lockBody(deps, token);
  let waited = 0;
  while (true) {
    const created = writeExclusive(root, lockPath, body);
    if (created === "created") {
      return { ok: true, value: { lockPath, token, pid: deps.pid } };
    }
    if (created !== "exists") return created;
    const owner = readLockOwner(lockPath);
    const waitExhausted = waited >= CURSOR_PLAN_CHOICE_LIMITS.lockWaitMs;
    if (!lockReclaimable(owner.pid, lockPath, deps, waitExhausted)) {
      if (waitExhausted) {
        return fail("lock-busy", "timed out waiting for planning-choice lock");
      }
      waited += CURSOR_PLAN_CHOICE_LIMITS.lockSleepMs;
      deps.sleepMs(CURSOR_PLAN_CHOICE_LIMITS.lockSleepMs);
      continue;
    }
    const ticket = acquireReclaimTicket(root, reclaimPath, body, deps);
    if (!ticket.ok) return ticket;
    try {
      const again = readLockOwner(lockPath);
      if (!lockReclaimable(again.pid, lockPath, deps, true)) {
        return fail("lock-busy", "timed out waiting for planning-choice lock");
      }
      if (!removeContained(root, lockPath) && existsSync(lockPath)) {
        return fail("lock-ambiguous", "could not reclaim a dead lock owner");
      }
      const retry = writeExclusive(root, lockPath, body);
      if (retry === "created") {
        return { ok: true, value: { lockPath, token, pid: deps.pid } };
      }
      if (retry !== "exists") return retry;
      waited += CURSOR_PLAN_CHOICE_LIMITS.lockSleepMs;
      if (waited >= CURSOR_PLAN_CHOICE_LIMITS.lockWaitMs) {
        return fail("lock-busy", "timed out waiting for planning-choice lock");
      }
      deps.sleepMs(CURSOR_PLAN_CHOICE_LIMITS.lockSleepMs);
    } finally {
      removeContained(root, reclaimPath);
    }
  }
}

function releaseLock(held: LockHeld, deps: CursorPlanChoiceDeps): void {
  const owner = readLockOwner(held.lockPath);
  if (owner.pid === held.pid && owner.token === held.token) {
    removeContained(deps.configDir, held.lockPath);
  }
}

function atomicWriteFile(
  path: string,
  body: string,
  deps: CursorPlanChoiceDeps,
): CursorPlanChoiceStoreResult<void> {
  const root = deps.configDir;
  const dir = dirname(path);
  const tmp = join(dir, `${deps.pid}.${deps.now()}.tmp`);
  if (!contained(planChoiceStoreRoot(deps), path) || !contained(planChoiceStoreRoot(deps), tmp)) {
    return fail("unsafe-path", "path escape");
  }
  try {
    containedWrite({
      root,
      target: tmp,
      data: body,
      mode: "create",
      mutation: false,
    });
    try {
      containedChmod({
        root,
        target: tmp,
        mode: CURSOR_PLAN_CHOICE_LIMITS.fileMode,
        mutation: false,
      });
    } catch {
      /* win32 may ignore mode */
    }
    containedRename({ root, from: tmp, to: path, mutation: false });
    return { ok: true, value: undefined };
  } catch (err) {
    removeContained(root, tmp);
    return containedFail(err, `atomic write failed for ${path}`);
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
    removeContained(deps.configDir, path);
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
        if (!removeContained(deps.configDir, recordPath) && existsSync(recordPath)) {
          return fail("storage-failure", "could not remove planning-choice record");
        }
      }
      return { ok: true, value: null };
    }
    const written = atomicWriteFile(recordPath, `${JSON.stringify(next.value, null, 2)}\n`, deps);
    if (!written.ok) return written;
    return { ok: true, value: next.value };
  } finally {
    releaseLock(lock.value, deps);
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
