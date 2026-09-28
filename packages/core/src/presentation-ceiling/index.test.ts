import { describe, expect, it } from "vitest";
import * as pc from "./index.js";

describe("presentation-ceiling index surface (#5056)", () => {
  it("re-exports evaluate and schema constants", () => {
    expect(typeof pc.evaluatePresentationCeiling).toBe("function");
    expect(typeof pc.evaluatePresentationCeilingFromSnapshot).toBe("function");
    expect(pc.GATE_ID).toBe("verify:presentation-ceiling");
    expect(pc.PRESENTATION_CHANGE_CLASS).toBe("presentation");
    expect(pc.BUILTIN_PRESENTATION_EXTS).toContain(".tsx");
    expect(pc.BUILTIN_PRESENTATION_EXTS).toContain(".css");
  });
});
