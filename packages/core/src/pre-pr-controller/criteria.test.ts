import { describe, expect, it } from "vitest";
import {
  bumpGeneration,
  digestApprovedCriteria,
  evaluateCriteriaAuthority,
  isHeadSideWeakening,
} from "./criteria.js";
import { PRE_PR_EXECUTION_SCHEMA, type PrePrExecutionRecord } from "./types.js";

const source = {
  sourceRevisionSha: "approved-rev",
  scopePaths: ["packages/core/src/pre-pr-controller/fixture-scope.ts"],
  acceptanceText: "controller-issued completion",
  generation: 1,
};

describe("criteria authority", () => {
  it("digests approved source revision and treats head weakening as a block", () => {
    const approved = digestApprovedCriteria(source);
    const sameAgain = digestApprovedCriteria(source);
    expect(approved.digest).toBe(sameAgain.digest);
    expect(approved.generation).toBe(1);
    const head = digestApprovedCriteria({
      ...source,
      sourceRevisionSha: "head-rev",
      acceptanceText: "weakened",
    });
    expect(isHeadSideWeakening(approved, head)).toBe(true);
    expect(isHeadSideWeakening(approved, approved)).toBe(false);
    expect(
      isHeadSideWeakening(
        approved,
        digestApprovedCriteria({ ...source, acceptanceText: "other ac" }),
      ),
    ).toBe(true);
    expect(
      isHeadSideWeakening(
        approved,
        digestApprovedCriteria({ ...source, scopePaths: ["other.ts"] }),
      ),
    ).toBe(true);
  });

  it("bumps generation and refuses stale or out-of-order publication", () => {
    const approved = digestApprovedCriteria(source);
    const bumped = bumpGeneration(approved, source);
    expect(bumped.generation).toBe(2);
    expect(bumped.digest).toBe(approved.digest);
    const record = {
      schema: PRE_PR_EXECUTION_SCHEMA,
      id: "ppr_crit_unit",
      criteria: approved,
      evaluationGeneration: 1,
      completedAt: "2026-01-01T00:00:00Z",
    } as PrePrExecutionRecord;
    expect(
      evaluateCriteriaAuthority({
        record,
        currentGeneration: 2,
        approved: bumped,
        headCriteria: null,
        lastInvalidationAt: null,
      }).code,
    ).toBe("deny-generation-stale");
    const other = digestApprovedCriteria({ ...source, acceptanceText: "different obligation" });
    expect(
      evaluateCriteriaAuthority({
        record: { ...record, evaluationGeneration: 1, criteria: other },
        currentGeneration: 1,
        approved,
        headCriteria: null,
        lastInvalidationAt: null,
      }).code,
    ).toBe("deny-criteria-invalidated");
    expect(
      evaluateCriteriaAuthority({
        record,
        currentGeneration: 1,
        approved,
        headCriteria: null,
        lastInvalidationAt: "2026-06-01T00:00:00Z",
      }).code,
    ).toBe("deny-out-of-order");
    expect(
      evaluateCriteriaAuthority({
        record,
        currentGeneration: 1,
        approved,
        headCriteria: null,
        lastInvalidationAt: null,
      }).ok,
    ).toBe(true);
  });
});
