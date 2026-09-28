import { describe, expect, it } from "vitest";
import {
  evaluateDurableEffectAcquisition,
  PRESENTATION_CEILING_ARTIFACT_REL,
  parsePresentationCeiling,
} from "./index.js";

describe("durable-effect-acquisition public surface (#5080)", () => {
  it("re-exports evaluate, parse, and the ceiling path", () => {
    expect(typeof evaluateDurableEffectAcquisition).toBe("function");
    expect(typeof parsePresentationCeiling).toBe("function");
    expect(PRESENTATION_CEILING_ARTIFACT_REL).toContain("presentation-ceiling.json");
    const parsed = parsePresentationCeiling(
      JSON.stringify({ schema: "deft.presentation-ceiling.v1", changeClass: "presentation" }),
    );
    expect("error" in parsed).toBe(false);
  });
});
