import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPlanChoiceTuple } from "./identity.js";
import { emptyPendingRecord, newPending, withPlanChoiceRecord } from "./store.js";
import type { CursorPlanChoiceDeps, CursorPlanChoiceIdentity } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(): CursorPlanChoiceDeps {
  const configDir = mkdtempSync(join(tmpdir(), "plan-choice-store-"));
  temps.push(configDir);
  return {
    now: () => 10_000,
    randomBytes: (size) => Buffer.alloc(size, 7),
    configDir,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
    processExists: (pid) => pid === process.pid,
    sleepMs: () => undefined,
    homedir: configDir,
    env: {},
  };
}

function identity(): CursorPlanChoiceIdentity {
  const workspaceRoot = "/workspace";
  const conversationId = "conv";
  return {
    conversationId,
    workspaceRoot,
    workspaceHash: hashPlanChoiceTuple(["cursor", workspaceRoot]),
    conversationHash: hashPlanChoiceTuple([conversationId]),
    recordKey: hashPlanChoiceTuple(["cursor", workspaceRoot, conversationId]),
  };
}

describe("withPlanChoiceRecord", () => {
  it("round-trips a pending record under an exclusive lock", () => {
    const d = deps();
    const id = identity();
    const written = withPlanChoiceRecord(d, id, () => {
      const pending = newPending(d);
      return { ok: true, value: emptyPendingRecord(id, pending) };
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value?.pending?.token).toHaveLength(32);
    const reread = withPlanChoiceRecord(d, id, (current) => ({ ok: true, value: current }));
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.value?.pending?.token).toBe(written.value?.pending?.token);
  });

  it("refuses a symlink record path", () => {
    if (process.platform === "win32") return;
    const d = deps();
    const id = identity();
    const root = join(d.configDir, "runtime", "cursor-plan-choice", "v1", id.workspaceHash);
    mkdirSync(root, { recursive: true });
    const target = join(root, "outside.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, join(root, `${id.conversationHash}.json`));
    const result = withPlanChoiceRecord(d, id, (current) => ({ ok: true, value: current }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsafe-path");
  });

  it("times out on a live foreign lock rather than reclaiming by age", () => {
    const d = deps();
    const id = identity();
    const root = join(d.configDir, "runtime", "cursor-plan-choice", "v1", id.workspaceHash);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${id.conversationHash}.json.lock`), "1\n1\n");
    const locked: CursorPlanChoiceDeps = {
      ...d,
      processExists: () => true,
      now: () => 50_000,
    };
    const result = withPlanChoiceRecord(locked, id, (current) => ({ ok: true, value: current }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("lock-busy");
  });
});
