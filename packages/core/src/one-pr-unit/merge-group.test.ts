import { describe, expect, it } from "vitest";
import { evaluateMergeGroupCheck, isMergeGroupChecksRequested } from "./merge-group.js";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";

const REPO = "deftai/directive";
const FIVE = [4204, 4218, 4161, 3918, 3849].map((issueId) => ({ repo: REPO, issueId }));

describe("merge_group.checks_requested census", () => {
  it("does not treat dequeue as the event name", () => {
    expect(isMergeGroupChecksRequested("dequeue")).toBe(false);
    expect(isMergeGroupChecksRequested("merge_group", "checks_requested")).toBe(true);
  });

  it("passes single-origin no-grant PRs so ordinary PRs are not blocked", () => {
    const store = new InProcessAppStore();
    const result = evaluateMergeGroupCheck({
      mergeGroupSha: "abc",
      store,
      constituentPrs: [
        {
          prNodeId: "PR_single",
          repo: REPO,
          closingIssuesReferences: [4494],
          body: "Closes #4494",
          commitMessages: ["feat: x"],
        },
      ],
    });
    expect(result.conclusion).toBe("success");
  });

  it("fails unbound multi-origin declarations", () => {
    const store = new InProcessAppStore();
    const result = evaluateMergeGroupCheck({
      mergeGroupSha: "abc",
      store,
      constituentPrs: [
        {
          prNodeId: "PR_multi",
          repo: REPO,
          closingIssuesReferences: [4204, 4218],
          body: "Closes #4204, #4218",
          commitMessages: [],
        },
      ],
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toMatch(/unbound|missing one-PR-unit/);
  });

  it("compares body + commit messages + closingIssuesReferences to the bound reservation", () => {
    const store = new InProcessAppStore();
    mintOnePrUnitGrant({
      store,
      actor: "dbcall2",
      approvalRef: "op",
      rationale: "five",
      origins: FIVE,
      repo: REPO,
      id: "unit-five",
    });
    store.bind("unit-five", "PR_five");
    const ok = evaluateMergeGroupCheck({
      mergeGroupSha: "deadbeef",
      store,
      constituentPrs: [
        {
          prNodeId: "PR_five",
          repo: REPO,
          closingIssuesReferences: [4204, 4218, 4161, 3918, 3849],
          body: "Closes #4204, #4218, #4161, #3918, #3849",
          commitMessages: ["feat: batch"],
        },
      ],
    });
    expect(ok.conclusion).toBe("success");
    const extra = evaluateMergeGroupCheck({
      mergeGroupSha: "deadbeef",
      store,
      constituentPrs: [
        {
          prNodeId: "PR_five",
          repo: REPO,
          closingIssuesReferences: [4204, 4218, 4161, 3918, 3849, 1],
          body: "Closes #4204",
          commitMessages: ["Closes #1"],
        },
      ],
    });
    expect(extra.conclusion).toBe("failure");
    expect(extra.summary).toMatch(/extra declaration/);
  });

  it("fails unreadable closer sources", () => {
    const store = new InProcessAppStore();
    const result = evaluateMergeGroupCheck({
      mergeGroupSha: "abc",
      store,
      constituentPrs: [
        {
          prNodeId: "PR_x",
          repo: REPO,
          closingIssuesReferences: null,
          body: "Closes #1",
          commitMessages: [],
        },
      ],
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toMatch(/unreadable/);
  });
});
