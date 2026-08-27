import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("busy") as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    });
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
    rmSync(root, { recursive: true, force: true });
  });

  it("retries exclusive creation after EEXIST", () => {
    let calls = 0;
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      return actualFs().openSync(...args);
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-retry-"));
    expect(projectDefinitionMutationLock(root, () => "ok", { sleepMs: () => undefined })).toBe(
      "ok",
    );
    expect(calls).toBe(2);
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
});
