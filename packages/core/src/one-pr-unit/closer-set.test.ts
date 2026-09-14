import { describe, expect, it } from "vitest";
import { closerSetFromIssueIds, extractIntentCloserSet } from "./closer-set.js";

describe("closer-set", () => {
  it("builds from issue ids", () => {
    expect(closerSetFromIssueIds("o/r", [2, 1, 2]).map((o) => o.issueId)).toEqual([1, 2]);
  });

  it("extracts comma-list intent origins", () => {
    const set = extractIntentCloserSet(["Closes #10, #20"], "o/r");
    expect(set.map((o) => o.issueId)).toEqual([10, 20]);
  });
});
