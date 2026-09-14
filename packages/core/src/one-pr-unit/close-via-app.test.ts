import { describe, expect, it } from "vitest";
import {
  assertNoDeftAllowEscape,
  CLAIMED_SET_REQUIRED,
  classifyDirectDefaultBranchClose,
  classifyNonAppClose,
  consumeClaimedSet,
  DEFT_ALLOW_NOT_ESCAPE,
} from "./close-via-app.js";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";

describe("App consume-then-close", () => {
  it("refuses missing claimed set", () => {
    const store = new InProcessAppStore();
    expect(() => consumeClaimedSet({ store, prNodeId: "PR_x", claimedSet: [] })).toThrow(
      CLAIMED_SET_REQUIRED,
    );
  });

  it("treats DEFT_ALLOW_* as a measured violation, not an escape", () => {
    expect(() => assertNoDeftAllowEscape({ DEFT_ALLOW_ISSUE_CLOSE: "1" })).toThrow(
      DEFT_ALLOW_NOT_ESCAPE,
    );
  });

  it("consumes remaining members after bind", () => {
    const store = new InProcessAppStore();
    mintOnePrUnitGrant({
      store,
      id: "unit",
      actor: "dbcall2",
      approvalRef: "r",
      rationale: "y",
      origins: [
        { repo: "o/r", issueId: 1 },
        { repo: "o/r", issueId: 2 },
      ],
      repo: "o/r",
    });
    store.bind("unit", "PR_n");
    consumeClaimedSet({
      store,
      prNodeId: "PR_n",
      claimedSet: [{ repo: "o/r", issueId: 1 }],
    });
    expect(store.getById("unit")?.state).toBe("member-complete");
    consumeClaimedSet({
      store,
      prNodeId: "PR_n",
      claimedSet: [{ repo: "o/r", issueId: 2 }],
    });
    expect(store.getById("unit")?.state).toBe("spent");
  });

  it("classifies UI closes as recovery-class", () => {
    expect(classifyNonAppClose("dbcall2").recoveryClass).toBe(true);
    expect(
      classifyDirectDefaultBranchClose({
        mergeGroupCheckPassed: false,
        allowDirectCommitsToMaster: true,
      }).message,
    ).toMatch(/allowDirectCommitsToMaster does not bypass/);
  });
});
