import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAILURE_MALFORMED_ASSIGNMENT,
  FAILURE_MISSING_ASSIGNMENT,
  FAILURE_ORPHAN_ASSIGNMENT,
  readWorkerAuthAssignment,
  workerAuthRecordName,
  writeWorkerAuthAssignment,
} from "./worker-auth-assignment.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
}

function linkedPair(): { main: string; worktree: string } {
  const main = mkdtempSync(join(tmpdir(), "wa-main-"));
  temps.push(main);
  gitInit(main);
  const worktree = mkdtempSync(join(tmpdir(), "wa-wt-"));
  temps.push(worktree);
  rmSync(worktree, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "-q", worktree, "HEAD"], { cwd: main });
  return { main, worktree };
}

describe("worker-auth-assignment (#3663)", () => {
  it("writes a record and index that the dest worktree can read", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
    expect(read.assignment?.expected_principal.login).toBe("worker-a");
    expect(read.assignment?.credential_delivery_id).toBeNull();
    expect(JSON.stringify(read)).not.toMatch(/ghp_|gho_|github_pat_/i);
  });

  it("treats an unregistered worktree as null, not a failure", () => {
    const { worktree } = linkedPair();
    const read = readWorkerAuthAssignment(worktree);
    expect(read).toEqual({ ok: true, assignment: null, commonDir: expect.any(String) });
  });

  it("fails closed when the dest is registered but the record is missing", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "injected-token",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: "del-1",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const record = join(
      written.commonDir,
      "deft-worker-auth",
      workerAuthRecordName(written.assignment.worktree_path),
    );
    rmSync(record);
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failureKind).toBe(FAILURE_MISSING_ASSIGNMENT);
  });

  it("fails closed on an orphan record without index registration", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    writeFileSync(
      join(written.commonDir, "deft-worker-auth", "index.json"),
      JSON.stringify({
        schema_version: Number.parseInt("1", 10),
        entries: [],
      }),
    );
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failureKind).toBe(FAILURE_ORPHAN_ASSIGNMENT);
  });

  it("fails closed on a malformed record", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const record = join(
      written.commonDir,
      "deft-worker-auth",
      workerAuthRecordName(written.assignment.worktree_path),
    );
    writeFileSync(record, "{not-json\n");
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failureKind).toBe(FAILURE_MALFORMED_ASSIGNMENT);
  });
});
