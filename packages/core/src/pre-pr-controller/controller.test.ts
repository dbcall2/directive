import { describe, expect, it } from "vitest";
import {
  completeRun,
  failRun,
  observeCommandPhase,
  startControllerRun,
  submitReviewerReport,
} from "./controller.js";
import { digestApprovedCriteria } from "./criteria.js";
import { evaluatePrePrEvidence } from "./evaluate.js";
import { ALLOWED_SKIP_REASONS } from "./phases.js";
import { InProcessPrePrStore, mintPublisher } from "./store.js";
import type { PrePrExecutionRecord } from "./types.js";

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
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(d.code).toBe("deny-failed");
  });
});
