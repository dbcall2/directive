import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControllerRun } from "./controller.js";
import { digestApprovedCriteria } from "./criteria.js";
import {
  FileBackedPrePrStore,
  getDefaultPrePrStore,
  InProcessPrePrStore,
  isPublisher,
  loadPrePrRecord,
  mintPublisher,
  opaqueRunId,
  PRE_PR_PRIVATE_STORE_DIR,
  PRE_PR_STORE_MAC_SECRET_NAME,
  PRE_PR_STORE_SECRET_MODE,
  parseStoredRecord,
  prePrDir,
  prePrStoreRecordFileName,
  privatePrePrStoreDir,
  requirePublisher,
  resetDefaultPrePrStore,
  resolveRecordFromStore,
  setDefaultPrePrStore,
  writePrePrRecordDisk,
} from "./store.js";
import { DISK_STORE_NOT_SOT, type PrePrExecutionRecord } from "./types.js";

describe("pre-pr private store", () => {
  it("treats run ids as lookup hints and disk as non-SoT", () => {
    const store = new InProcessPrePrStore();
    expect(resolveRecordFromStore(store, { id: "missing" })).toBeNull();
    expect(loadPrePrRecord(".", "missing", store)).toBeNull();
    expect(prePrDir(".").message).toBe(DISK_STORE_NOT_SOT);
    expect(writePrePrRecordDisk(".", {} as PrePrExecutionRecord).code).toBe("deny-disk-not-sot");
    expect(opaqueRunId("  ppr_hint  ")).toBe("ppr_hint");
    expect(opaqueRunId().startsWith("ppr_")).toBe(true);
    expect(isPublisher({})).toBe(false);
    expect(requirePublisher({}).ok).toBe(false);
    expect(isPublisher(mintPublisher())).toBe(true);
    const def = resetDefaultPrePrStore();
    expect(getDefaultPrePrStore()).toBe(def);
    const other = new InProcessPrePrStore();
    setDefaultPrePrStore(other);
    expect(getDefaultPrePrStore()).toBe(other);
    resetDefaultPrePrStore();
  });

  it("indexes by PR node id after put", () => {
    const store = new InProcessPrePrStore();
    const record = {
      id: "ppr_node",
      prNodeId: "PR_kwDOX",
    } as PrePrExecutionRecord;
    store.put(record);
    expect(store.getByPrNodeId("PR_kwDOX")?.id).toBe("ppr_node");
    expect(store.getByPrNodeId("missing")).toBeNull();
    expect(resolveRecordFromStore(store, { prNodeId: "PR_kwDOX" })?.id).toBe("ppr_node");
    expect(resolveRecordFromStore(store, { id: "ppr_node" })?.id).toBe("ppr_node");
    expect(resolveRecordFromStore(store, {})).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("round-trips a record across a new file-backed store instance", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-store-"));
    try {
      const first = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      startControllerRun(first, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_1",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_disk",
      });
      const second = new FileBackedPrePrStore(root);
      expect(second.getById("ppr_disk")?.id).toBe("ppr_disk");
      expect(second.getByPrNodeId("PR_1")?.id).toBe("ppr_disk");
      expect(second.list()).toHaveLength(1);
      expect(privatePrePrStoreDir(root)).toContain(PRE_PR_PRIVATE_STORE_DIR);
      expect(privatePrePrStoreDir(root).includes("pre-pr-controller")).toBe(false);
      const secretPath = join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME);
      expect(statSync(secretPath).isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(secretPath).mode & 0o777).toBe(PRE_PR_STORE_SECRET_MODE);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a second FileBackedPrePrStore put after the first created the HMAC secret", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-race-"));
    try {
      const first = new FileBackedPrePrStore(root);
      const second = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      const start = (store: FileBackedPrePrStore, runId: string) =>
        startControllerRun(store, {
          repo: "deftai/directive",
          baseSha: "a",
          headSha: "b",
          treeHash: "c",
          prBodyHash: "d",
          prNodeId: "PR_race",
          criteria,
          skillVersion: "0.1",
          policyVersion: "1",
          approvedRevisionSha: "a",
          runId,
        });
      expect(start(first, "ppr_race_a").ok).toBe(true);
      expect(first.getById("ppr_race_a")?.id).toBe("ppr_race_a");
      let secondStart: ReturnType<typeof startControllerRun> | undefined;
      expect(() => {
        secondStart = start(second, "ppr_race_b");
      }).not.toThrow();
      expect(secondStart?.ok).toBe(true);
      expect(second.getById("ppr_race_b")?.id).toBe("ppr_race_b");
      expect(second.getById("ppr_race_a")?.id).toBe("ppr_race_a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the winner secret when HMAC secret create races with EXISTS", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-exists-"));
    try {
      const first = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      startControllerRun(first, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_exists",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_win",
      });
      const winner = first.getById("ppr_win") as PrePrExecutionRecord;
      const second = new FileBackedPrePrStore(root);
      type SecretLoader = { loadSecret(): Buffer | null };
      const proto = FileBackedPrePrStore.prototype as unknown as SecretLoader;
      const original = proto.loadSecret;
      let missOnce = true;
      proto.loadSecret = function loadSecretMissOnce(this: FileBackedPrePrStore): Buffer | null {
        if (missOnce) {
          missOnce = false;
          return null;
        }
        return original.call(this);
      };
      try {
        let put: ReturnType<FileBackedPrePrStore["put"]> | undefined;
        expect(() => {
          put = second.put({
            ...winner,
            id: "ppr_loser",
          });
        }).not.toThrow();
        expect(put?.ok).toBe(true);
        expect(second.getById("ppr_loser")?.id).toBe("ppr_loser");
      } finally {
        proto.loadSecret = original;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies put when HMAC secret create races but the winner cannot be loaded", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-empty-"));
    try {
      mkdirSync(privatePrePrStoreDir(root), { recursive: true });
      writeFileSync(join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME), "\n");
      const store = new FileBackedPrePrStore(root);
      const decision = store.put({
        id: "ppr_empty_secret",
        prNodeId: "PR_empty",
      } as PrePrExecutionRecord);
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe("deny-missing-record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsigned JSON and loads only MAC-wrapped records", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-mac-"));
    try {
      const store = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      startControllerRun(store, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_mac",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_signed",
      });
      expect(store.getById("ppr_signed")?.id).toBe("ppr_signed");
      const forgedId = "ppr_unsigned";
      const unsigned: PrePrExecutionRecord = {
        ...(store.getById("ppr_signed") as PrePrExecutionRecord),
        id: forgedId,
        outcome: "pass",
        state: "complete",
      };
      const dir = privatePrePrStoreDir(root);
      writeFileSync(join(dir, prePrStoreRecordFileName(forgedId)), `${JSON.stringify(unsigned)}\n`);
      expect(store.getById(forgedId)).toBeNull();
      const secret = Buffer.from(
        readFileSync(join(dir, PRE_PR_STORE_MAC_SECRET_NAME), "utf8").trim(),
        "hex",
      );
      expect(parseStoredRecord(JSON.stringify(unsigned), secret)).toBeNull();
      const envelopeRaw = readFileSync(join(dir, prePrStoreRecordFileName("ppr_signed")), "utf8");
      expect(parseStoredRecord(envelopeRaw, secret)?.id).toBe("ppr_signed");
      expect(parseStoredRecord(envelopeRaw, Buffer.from("00".repeat(32), "hex"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the newest PR-node record and lets a presented run id win", () => {
    const store = new InProcessPrePrStore();
    const criteria = digestApprovedCriteria({
      sourceRevisionSha: "a",
      scopePaths: ["x.ts"],
      acceptanceText: "ac",
      generation: 1,
    });
    const start = (runId: string, now: Date) =>
      startControllerRun(store, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_dup",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId,
        now,
      });
    start("ppr_newer", new Date("2026-10-02T12:00:00Z"));
    start("ppr_older", new Date("2026-10-02T11:00:00Z"));
    expect(store.getByPrNodeId("PR_dup")?.id).toBe("ppr_newer");
    expect(resolveRecordFromStore(store, { id: "ppr_older", prNodeId: "PR_dup" })?.id).toBe(
      "ppr_older",
    );
    expect(resolveRecordFromStore(store, { prNodeId: "PR_dup" })?.id).toBe("ppr_newer");

    const root = mkdtempSync(join(tmpdir(), "pre-pr-newest-"));
    try {
      const disk = new FileBackedPrePrStore(root);
      const startDisk = (runId: string, now: Date) =>
        startControllerRun(disk, {
          repo: "deftai/directive",
          baseSha: "a",
          headSha: "b",
          treeHash: "c",
          prBodyHash: "d",
          prNodeId: "PR_dup",
          criteria,
          skillVersion: "0.1",
          policyVersion: "1",
          approvedRevisionSha: "a",
          runId,
          now,
        });
      startDisk("ppr_newer", new Date("2026-10-02T12:00:00Z"));
      startDisk("ppr_older", new Date("2026-10-02T11:00:00Z"));
      expect(disk.getByPrNodeId("PR_dup")?.id).toBe("ppr_newer");
      expect(resolveRecordFromStore(disk, { id: "ppr_older", prNodeId: "PR_dup" })?.id).toBe(
        "ppr_older",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
