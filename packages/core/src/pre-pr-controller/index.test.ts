import { describe, expect, it } from "vitest";
import {
  digestApprovedCriteria,
  evaluatePrePrEvidence,
  noteSkillFileOpen,
  PRE_PR_WORKFLOW_VERSION,
  RENDER_EXPORT_RULE,
} from "./index.js";

describe("pre-pr-controller public surface", () => {
  it("re-exports workflow constants and fail-closed decisions", () => {
    expect(PRE_PR_WORKFLOW_VERSION).toBe("deft.pre-pr-workflow.v1");
    expect(RENDER_EXPORT_RULE).toContain("never create missing exports");
    const d = noteSkillFileOpen();
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-skill-file-open");
    const approved = digestApprovedCriteria({
      sourceRevisionSha: "rev",
      scopePaths: ["packages/core/src/pre-pr-controller/fixture-scope.ts"],
      acceptanceText: "ac",
      generation: 1,
    });
    const blocked = evaluatePrePrEvidence({
      record: null,
      liveBinding: {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        prNodeId: null,
        prBodyHash: "d",
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("deny-missing-record");
  });
});
