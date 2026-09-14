import { describe, expect, it } from "vitest";
import { runMergeGroupCheckFromEvent } from "./merge-group-cli.js";
import { InProcessAppStore } from "./simulator.js";

describe("merge-group CLI", () => {
  it("fails closed on missing head sha", () => {
    const result = runMergeGroupCheckFromEvent({ action: "checks_requested" });
    expect(result.conclusion).toBe("failure");
  });

  it("passes a single-origin constituent when the App store has no grant", () => {
    const store = new InProcessAppStore();
    const result = runMergeGroupCheckFromEvent(
      { action: "checks_requested", merge_group: { head_sha: "abc" } },
      {
        store,
        loadConstituents: () => [
          {
            prNodeId: "PR_1",
            repo: "deftai/directive",
            closingIssuesReferences: [4494],
            body: "Closes #4494",
            commitMessages: [],
          },
        ],
      },
    );
    expect(result.conclusion).toBe("success");
  });
});
