import { describe, expect, it } from "vitest";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";

describe("mintOnePrUnitGrant", () => {
  it("refuses a single origin", () => {
    const store = new InProcessAppStore();
    expect(() =>
      mintOnePrUnitGrant({
        store,
        actor: "dbcall2",
        approvalRef: "ref",
        rationale: "why",
        origins: [{ repo: "o/r", issueId: 1 }],
        repo: "o/r",
      }),
    ).toThrow(/at least two origins/);
  });

  it("mints reserved and unbound", () => {
    const store = new InProcessAppStore();
    const claim = mintOnePrUnitGrant({
      store,
      actor: "dbcall2",
      approvalRef: "ref",
      rationale: "why",
      origins: [
        { repo: "o/r", issueId: 1 },
        { repo: "o/r", issueId: 2 },
      ],
      repo: "o/r",
    });
    expect(claim.state).toBe("reserved");
    expect(claim.prNodeId).toBeNull();
  });
});
