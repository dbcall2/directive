import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import { type PlanSequenceLockDeps, withPlanSequenceSidecarLock } from "./mutation-lock.js";
import { PLAN_SEQUENCE_FILENAME, type PlanSequence, parsePlanSequence } from "./types.js";

export function planSequencePath(projectRoot: string): string {
  return join(projectRoot, ".deft", PLAN_SEQUENCE_FILENAME);
}

export function planSequenceLockPath(projectRoot: string): string {
  return `${planSequencePath(projectRoot)}.lock`;
}

export type PlanSequenceMutationCode =
  | "missing-expected-generation"
  | "generation-mismatch"
  | "lock-timeout"
  | "lock-reentrant"
  | "parse-error";

export interface PlanSequenceMutationFail {
  readonly ok: false;
  readonly code: PlanSequenceMutationCode;
  readonly current_generation: number;
  readonly source_revision: string;
  readonly message: string;
}

export type WritePlanSequenceResult =
  | { readonly ok: true; readonly path: string; readonly sequence: PlanSequence }
  | PlanSequenceMutationFail;

export type ClearPlanSequenceResult =
  | { readonly ok: true; readonly path: string; readonly removed: boolean }
  | PlanSequenceMutationFail;

export interface PlanSequenceMutationOptions {
  readonly sourceRevision?: string;
  readonly afterAcquire?: () => void;
  readonly lock?: PlanSequenceLockDeps;
}

function isExpectedGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function missingExpected(): PlanSequenceMutationFail {
  return {
    ok: false,
    code: "missing-expected-generation",
    current_generation: 0,
    source_revision: "",
    message:
      "plan-sequence mutation requires expected_generation (non-negative integer). Reload .deft/plan-sequence.json and retry.",
  };
}

function mismatch(current: PlanSequence | null, expected: number): PlanSequenceMutationFail {
  const current_generation = current?.generation ?? 0;
  const source_revision = current?.source_revision ?? "";
  return {
    ok: false,
    code: "generation-mismatch",
    current_generation,
    source_revision,
    message:
      `plan-sequence generation mismatch: expected ${String(expected)}, current ${String(current_generation)}. ` +
      "Reload .deft/plan-sequence.json and retry with the current generation.",
  };
}

function observeSourceRevision(projectRoot: string, override?: string): string {
  if (override !== undefined) return override;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function parseError(detail: string): PlanSequenceMutationFail {
  return {
    ok: false,
    code: "parse-error",
    current_generation: 0,
    source_revision: "",
    message: `plan-sequence: refused mutation because the on-disk record could not be parsed (${detail})`,
  };
}

function readOnDisk(
  path: string,
): { ok: true; sequence: PlanSequence | null } | PlanSequenceMutationFail {
  if (!existsSync(path)) {
    return { ok: true, sequence: null };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "generation")) {
      const generation = (raw as { generation: unknown }).generation;
      if (!isExpectedGeneration(generation)) {
        return parseError("generation must be a non-negative integer");
      }
    }
    return { ok: true, sequence: parsePlanSequence(raw) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return parseError(detail);
  }
}

export function readPlanSequence(projectRoot: string): PlanSequence | null {
  const path = planSequencePath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parsePlanSequence(raw);
}

function persistPublished(
  root: string,
  path: string,
  published: PlanSequence,
  exclusiveCreate: boolean,
): void {
  containedWrite({
    root,
    target: path,
    data: `${JSON.stringify(published, null, 2)}\n`,
    mode: exclusiveCreate ? "create" : "replace",
  });
}

export function writePlanSequence(
  projectRoot: string,
  sequence: PlanSequence,
  expected_generation: number,
  options: PlanSequenceMutationOptions = {},
): WritePlanSequenceResult {
  if (!isExpectedGeneration(expected_generation)) {
    return missingExpected();
  }
  const root = resolve(projectRoot);
  const path = planSequencePath(root);
  const locked = withPlanSequenceSidecarLock(
    planSequenceLockPath(root),
    () => {
      options.afterAcquire?.();
      const onDisk = readOnDisk(path);
      if (!onDisk.ok) return onDisk;
      const current = onDisk.sequence;
      const currentGeneration = current?.generation ?? 0;
      if (expected_generation !== currentGeneration) {
        return mismatch(current, expected_generation);
      }
      const published: PlanSequence = {
        ...sequence,
        generation: currentGeneration + 1,
        source_revision: observeSourceRevision(root, options.sourceRevision),
      };
      persistPublished(root, path, published, current === null);
      return { ok: true as const, path, sequence: published };
    },
    options.lock,
  );
  if (!locked.ok) {
    return {
      ok: false,
      code: locked.code,
      current_generation: 0,
      source_revision: "",
      message: locked.message,
    };
  }
  return locked.value;
}

export function clearPlanSequence(
  projectRoot: string,
  expected_generation: number,
  options: PlanSequenceMutationOptions = {},
): ClearPlanSequenceResult {
  if (!isExpectedGeneration(expected_generation)) {
    return missingExpected();
  }
  const root = resolve(projectRoot);
  const path = planSequencePath(root);
  const locked = withPlanSequenceSidecarLock(
    planSequenceLockPath(root),
    () => {
      options.afterAcquire?.();
      const onDisk = readOnDisk(path);
      if (!onDisk.ok) return onDisk;
      const current = onDisk.sequence;
      const currentGeneration = current?.generation ?? 0;
      if (expected_generation !== currentGeneration) {
        return mismatch(current, expected_generation);
      }
      if (current === null) {
        return { ok: true as const, path, removed: false };
      }
      containedRemove({ root, target: path });
      return { ok: true as const, path, removed: true };
    },
    options.lock,
  );
  if (!locked.ok) {
    return {
      ok: false,
      code: locked.code,
      current_generation: 0,
      source_revision: "",
      message: locked.message,
    };
  }
  return locked.value;
}
