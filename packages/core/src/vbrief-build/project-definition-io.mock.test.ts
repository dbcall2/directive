import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  openSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  actualFs: null as typeof import("node:fs") | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  hoisted.actualFs = actual;
  return {
    ...actual,
    readFileSync: hoisted.readFileSyncMock,
    openSync: hoisted.openSyncMock,
    existsSync: hoisted.existsSyncMock,
  };
});

import {
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
} from "./project-definition-io.js";

/** Real fs module captured after vi.mock — throw if hoisted setup failed. */
function actualFs(): typeof import("node:fs") {
  const fs = hoisted.actualFs;
  if (fs === null) {
    throw new Error("actualFs not initialized by vi.mock");
  }
  return fs;
}

describe("projectDefinitionIO mocked fs branches", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("raises when readFileSync fails for load", () => {
    hoisted.existsSyncMock.mockReturnValue(true);
    hoisted.readFileSyncMock.mockImplementation((path) => {
      if (String(path).includes("PROJECT-DEFINITION.xbrief.json")) {
        throw new Error("read denied");
      }
      return actualFs().readFileSync(path);
    });
    const root = mkdtempSync(join(tmpdir(), "vb-pd-mock-"));
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(
      /Could not read PROJECT-DEFINITION/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("times out on a live owner without deleting its sidecar", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-mock-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");
    let tick = 0;
    expect(() =>
      projectDefinitionMutationLock(root, () => undefined, {
        sleepMs: () => undefined,
        now: () => {
          tick += 20_000;
          return tick;
        },
      }),
    ).toThrow("timed out waiting for project definition mutation lock");
    expect(existsSync(lockPath)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rethrows non-busy openSync errors", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("weird") as NodeJS.ErrnoException;
      err.code = "EISDIR";
      throw err;
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-weird-"));
    expect(() => projectDefinitionMutationLock(root, () => undefined)).toThrow("weird");
    expect(readdirSync(join(root, "xbrief"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("propagates EACCES instead of masking it as lock contention", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-eacces-"));
    expect(() => projectDefinitionMutationLock(root, () => "ok")).toThrow("denied");
    rmSync(root, { recursive: true, force: true });
  });

  it("propagates an acquisition rename EACCES when no owner lock exists", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-rename-eacces-"));
    const lockDir = join(root, "xbrief");
    const lockPath = join(lockDir, "PROJECT-DEFINITION.xbrief.json.lock");
    const denied = new Error("rename denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";

    expect(() =>
      projectDefinitionMutationLock(root, () => "no", {
        renameLock: () => {
          throw denied;
        },
      }),
    ).toThrow("rename denied");
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(lockDir)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("reaps a dead lock owner and acquires the sidecar", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-stale-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999, token: "stale" })}\n`, "utf8");

    expect(
      projectDefinitionMutationLock(root, () => "ok", {
        isProcessAlive: (pid) => {
          expect(pid).toBe(999_999);
          return false;
        },
      }),
    ).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["legacy NUL PID", `\0\0${2_147_483_647}\n`],
    ["partial JSON owner", `{"pid":${2_147_483_647}`],
  ])("recovers a dead %s sidecar", (_label, sidecar) => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-legacy-sidecar-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(lockPath, sidecar, "utf8");

    expect(projectDefinitionMutationLock(root, () => "ok")).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers an aged empty legacy sidecar", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-empty-sidecar-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(lockPath, "", "utf8");

    expect(
      projectDefinitionMutationLock(root, () => "ok", {
        now: () => Date.now() + 5_000,
      }),
    ).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["empty acquisition directory", null],
    ["partial owner entry", "partial-owner"],
  ])("recovers an aged %s", (_label, entryName) => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-malformed-dir-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(lockPath, { recursive: true });
    if (entryName !== null) writeFileSync(join(lockPath, entryName), "partial", "utf8");

    expect(
      projectDefinitionMutationLock(root, () => "ok", {
        now: () => Date.now() + 5_000,
      }),
    ).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not age-reap a malformed directory that still identifies a live owner", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-malformed-live-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    const liveEntry = `${process.pid}-${"a".repeat(32)}`;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, liveEntry), "partial", "utf8");
    writeFileSync(join(lockPath, "debris"), "partial", "utf8");
    let tick = Date.now() + 5_000;

    expect(() =>
      projectDefinitionMutationLock(root, () => "no", {
        isProcessAlive: (pid) => pid === process.pid,
        now: () => {
          tick += 20_000;
          return tick;
        },
        sleepMs: () => undefined,
      }),
    ).toThrow("timed out waiting for project definition mutation lock");
    expect(readdirSync(lockPath).sort()).toEqual(["debris", liveEntry].sort());
    rmSync(root, { recursive: true, force: true });
  });

  it("cleans its lock directory after a short owner-metadata write", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-short-owner-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");

    expect(() =>
      projectDefinitionMutationLock(root, () => "no", {
        writeOwner: () => 1,
      }),
    ).toThrow("short write while recording project definition lock owner");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
