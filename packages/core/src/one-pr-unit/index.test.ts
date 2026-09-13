import { describe, expect, it } from "vitest";
import * as onePrUnit from "./index.js";

describe("one-pr-unit index", () => {
  it("re-exports the decision procedure and mint", () => {
    expect(typeof onePrUnit.evaluateOnePrUnit).toBe("function");
    expect(typeof onePrUnit.mintOnePrUnitGrant).toBe("function");
    expect(onePrUnit.ONE_PR_UNIT_SCHEMA).toBe("deft.one-pr-unit.v1");
  });
});
