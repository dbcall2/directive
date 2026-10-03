import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  completeRun,
  computeControllerObservedHash,
  failRun,
  observeCommandPhase,
  runObservablesComplete,
  startControllerRun,
  submitReviewerReport,
} from "./controller.js";
import { digestApprovedCriteria } from "./criteria.js";
import { evaluatePrePrEvidence } from "./evaluate.js";
import { ALLOWED_SKIP_REASONS, PRE_PR_PHASES } from "./phases.js";
import { InProcessPrePrStore, mintPublisher, type PrePrExecutionStore } from "./store.js";
import { deny, type PrePrExecutionRecord } from "./types.js";

const approved = digestApprovedCriteria({
  sourceRevisionSha: "base",
  scopePaths: ["a.ts"],
  acceptanceText: "ac",
  generation: 1,
});

function start(store: InProcessPrePrStore, runId: string): PrePrExecutionRecord {
  startControllerRun(store, {
    repo: "deftai/directive",
    baseSha: "base",
    headSha: "head",
    treeHash: "tree",
    prBodyHash: "body",
    prNodeId: null,
    criteria: approved,
    skillVersion: "0.1",
    policyVersion: "1",
    approvedRevisionSha: "base",
    runId,
  });
  return store.getById(runId) as PrePrExecutionRecord;
}

describe("computeControllerObservedHash", () => {
  it("returns null for a directory reviewed path without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-hash-dir-"));
    try {
      mkdirSync(join(dir, "nested"), { recursive: true });
      expect(() => computeControllerObservedHash({ reviewedFiles: [dir] })).not.toThrow();
      expect(computeControllerObservedHash({ reviewedFiles: [dir] })).toBeNull();
      expect(computeControllerObservedHash({ reviewedFiles: [join(dir, "nested")] })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes a readable file and returns null for a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-hash-file-"));
    try {
      const file = join(dir, "reviewed.ts");
      writeFileSync(file, "contents\n");
      const hash = computeControllerObservedHash({ reviewedFiles: [file] });
      expect(typeof hash).toBe("string");
      expect(hash?.length).toBeGreaterThan(0);
      expect(
        computeControllerObservedHash({ reviewedFiles: [join(dir, "missing.ts")] }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startControllerRun put deny", () => {
  it("returns ok false and a null run id when store.put denies", () => {
    const store: PrePrExecutionStore = {
      put: () =>
        deny("deny-missing-record", "pre-PR private store HMAC secret could not be created"),
      getById: () => null,
      getByPrNodeId: () => null,
      list: () => [],
    };
    const started = startControllerRun(store, {
      repo: "deftai/directive",
      baseSha: "base",
      headSha: "head",
      treeHash: "tree",
      prBodyHash: "body",
      prNodeId: null,
      criteria: approved,
      skillVersion: "0.1",
      policyVersion: "1",
      approvedRevisionSha: "base",
      runId: "ppr_put_deny",
    });
    expect(started.ok).toBe(false);
    expect(started.runId).toBeNull();
    expect(started.decision.ok).toBe(false);
    expect(started.decision.code).toBe("deny-missing-record");
  });
});

describe("controller observations", () => {
  it("accepts the closed plan_sequence skip and rejects a mismatched input hash", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_skip");
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "plan_sequence",
        command: "deft verify:plan-sequence",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: ALLOWED_SKIP_REASONS.plan_sequence ?? "",
      }).ok,
    ).toBe(true);
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "merge_chokepoint",
        command: "deft check",
        exitCode: 0,
        inputHash: "other",
        skipReason: null,
      }).code,
    ).toBe("deny-input-mismatch");
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "read",
        command: "n/a",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      }).code,
    ).toBe("deny-input-mismatch");
  });

  it("stores reviewer prose without letting it mint a pass, and write-change clears no-change", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_sem");
    expect(
      submitReviewerReport(store, rec.id, {
        phaseId: "merge_chokepoint",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h1",
        criteriaDigest: approved.digest,
        reviewerReportRef: "looks good",
        controllerObservedHash: "h1",
      }).code,
    ).toBe("deny-input-mismatch");
    expect(
      submitReviewerReport(store, rec.id, {
        phaseId: "loop",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "final",
        criteriaDigest: approved.digest,
        reviewerReportRef: "ship it",
        controllerObservedHash: "final",
      }).ok,
    ).toBe(true);
    expect(store.getById(rec.id)?.finalNoChange).toBe(true);
    expect(
      submitReviewerReport(store, rec.id, {
        phaseId: "write",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "before",
        criteriaDigest: approved.digest,
        reviewerReportRef: "fixed",
        controllerObservedHash: "after",
      }).ok,
    ).toBe(true);
    expect(store.getById(rec.id)?.finalNoChange).toBe(false);
    expect(completeRun(store, mintPublisher(), rec.id).ok).toBe(false);
  });

  it("allows a closed skip with a non-zero exit and refuses a missing run", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_skip_exit");
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "plan_sequence",
        command: "deft verify:plan-sequence",
        exitCode: 1,
        inputHash: rec.inputHash,
        skipReason: ALLOWED_SKIP_REASONS.plan_sequence ?? "",
      }).ok,
    ).toBe(true);
    expect(store.getById(rec.id)?.state).toBe("running");
    expect(
      observeCommandPhase(store, "missing", {
        phaseId: "branch_policy",
        command: "deft verify:branch",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      }).code,
    ).toBe("deny-missing-record");
    expect(completeRun(store, mintPublisher(), "missing").code).toBe("deny-missing-record");
  });

  it("refuses a second publish and a semantic digest mismatch", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_second");
    for (const phase of [
      "branch_policy",
      "plan_sequence",
      "lint_iteration",
      "coverage_headroom",
      "render_export",
      "merge_chokepoint",
    ] as const) {
      observeCommandPhase(store, rec.id, {
        phaseId: phase,
        command: "cmd",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      });
    }
    for (const phase of ["read", "write", "diff", "loop"] as const) {
      submitReviewerReport(store, rec.id, {
        phaseId: phase,
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h",
        criteriaDigest: approved.digest,
        reviewerReportRef: "r",
        controllerObservedHash: "h",
      });
    }
    expect(completeRun(store, mintPublisher(), rec.id).ok).toBe(true);
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "branch_policy",
        command: "cmd",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      }).code,
    ).toBe("deny-incomplete");
    const rec2 = start(store, "ppr_digest");
    expect(
      submitReviewerReport(store, rec2.id, {
        phaseId: "read",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h",
        criteriaDigest: "not-the-approved-digest",
        reviewerReportRef: "r",
        controllerObservedHash: "h",
      }).code,
    ).toBe("deny-criteria-invalidated");
  });

  it("denies required phases recorded out of PRE_PR_PHASES order", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_order");
    const at = (sec: number) => new Date(`2026-01-01T00:00:${String(sec).padStart(2, "0")}Z`);
    for (const [i, spec] of PRE_PR_PHASES.entries()) {
      const now = spec.id === "merge_chokepoint" ? at(1) : at(10 + i);
      if (spec.kind === "command-observable") {
        observeCommandPhase(store, rec.id, {
          phaseId: spec.id,
          command: spec.command ?? "cmd",
          exitCode: 0,
          inputHash: rec.inputHash,
          skipReason: null,
          now,
        });
      } else {
        submitReviewerReport(store, rec.id, {
          phaseId: spec.id,
          reviewedFileManifest: ["a.ts"],
          suppliedContentsHash: "h",
          criteriaDigest: approved.digest,
          reviewerReportRef: "r",
          controllerObservedHash: "h",
          now,
        });
      }
    }
    const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord);
    expect(decided.code).toBe("deny-out-of-order");
    expect(completeRun(store, mintPublisher(), rec.id).code).toBe("deny-out-of-order");
  });

  it("denies write, diff, and loop when supplied and observed hashes differ", () => {
    for (const mismatch of ["write", "diff", "loop"] as const) {
      const store = new InProcessPrePrStore();
      const rec = start(store, `ppr_hash_${mismatch}`);
      for (const spec of PRE_PR_PHASES) {
        if (spec.kind === "command-observable") {
          observeCommandPhase(store, rec.id, {
            phaseId: spec.id,
            command: spec.command ?? "cmd",
            exitCode: 0,
            inputHash: rec.inputHash,
            skipReason: null,
          });
        } else {
          const match = spec.id !== mismatch;
          submitReviewerReport(store, rec.id, {
            phaseId: spec.id,
            reviewedFileManifest: ["a.ts"],
            suppliedContentsHash: match ? "h" : "supplied",
            criteriaDigest: approved.digest,
            reviewerReportRef: "r",
            controllerObservedHash: match ? "h" : "observed",
          });
        }
      }
      const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord);
      expect(decided.ok).toBe(false);
      expect(["deny-omitted-phase", "deny-incomplete"]).toContain(decided.code);
    }
  });

  it("failRun blocks evaluate even with a presented id", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_failrun");
    failRun(store, rec.id);
    const d = evaluatePrePrEvidence({
      record: store.getById(rec.id),
      liveBinding: {
        repo: "deftai/directive",
        baseSha: "base",
        headSha: "head",
        prNodeId: null,
        prBodyHash: "body",
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(d.code).toBe("deny-failed");
  });
});
