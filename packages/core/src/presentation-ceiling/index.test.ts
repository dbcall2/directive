import { describe, expect, it } from "vitest";
import * as ceiling from "./index.js";

describe("presentation-ceiling index (#5079)", () => {
  it("exports schema, compositor id, and compare helpers", () => {
    expect(ceiling.PRESENTATION_CEILING_SCHEMA).toBe("deft.presentation-ceiling.v1");
    expect(ceiling.CEILING_COMPOSITOR_GATE_ID).toBe("verify:presentation-ceiling");
    expect(ceiling.isPresentationPath("src/View.tsx")).toBe(true);
    expect(ceiling.isPresentationPath("styles/app.css")).toBe(true);
    expect(ceiling.isPresentationPath("db/001.sql")).toBe(false);
    expect(ceiling.isCeilingArtifactRel(".deft/presentation-ceilings/story.json")).toBe(true);
  });
});
