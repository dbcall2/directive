import { expect, it } from "vitest";
import * as coverage from "./index.js";

it("exports the distinct compositor and shared supplier schema", () => {
  expect(coverage.CEILING_COMPOSITOR_GATE_ID).toBe("verify:presentation-coverage");
  expect(coverage.PRESENTATION_CEILING_SCHEMA).toBe("deft.presentation-ceiling.v1");
  expect(coverage.COMPOSED_GATE_IDS).not.toContain(coverage.CEILING_COMPOSITOR_GATE_ID);
  expect(typeof coverage.evaluatePresentationCoverage).toBe("function");
});
