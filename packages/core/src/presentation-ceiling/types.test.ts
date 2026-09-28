import { describe, expect, it } from "vitest";
import { parsePresentationCeilingArtifact } from "./artifact.js";
import { isCeilingArtifactRel, isPresentationPath } from "./paths.js";
import {
  BUILTIN_PRESENTATION_EXTENSIONS,
  CEILING_COMPOSITOR_GATE_ID,
  PRESENTATION_CEILING_DIR,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
} from "./types.js";

describe("presentation-ceiling types (#5056 / #5079)", () => {
  it("pins the shared artifact store and compositor id", () => {
    expect(PRESENTATION_CEILING_DIR).toBe(".deft/presentation-ceilings");
    expect(CEILING_COMPOSITOR_GATE_ID).toBe("verify:presentation-ceiling");
    expect(BUILTIN_PRESENTATION_EXTENSIONS).toContain(".css");
    expect(isCeilingArtifactRel(`${PRESENTATION_CEILING_DIR}/story.json`)).toBe(true);
    expect(isPresentationPath("src/View.tsx")).toBe(true);
    const parsed = parsePresentationCeilingArtifact({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: PRESENTATION_CHANGE_CLASS,
      extraExtensions: [".sql"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.artifact.schema).toBe(PRESENTATION_CEILING_SCHEMA);
    expect(parsed.artifact.extraExtensions).toContain(".sql");
  });
});
