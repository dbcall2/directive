import { describe, expect, it } from "vitest";
import { parseArtifactText, parsePresentationCeilingArtifact } from "./artifact.js";
import { PRESENTATION_CEILING_SCHEMA, PRESENTATION_CHANGE_CLASS } from "./types.js";

describe("parsePresentationCeilingArtifact (#5056 schema / #5079)", () => {
  it("accepts a restriction-only presentation artifact", () => {
    const parsed = parsePresentationCeilingArtifact({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: PRESENTATION_CHANGE_CLASS,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.artifact.allowlist).toEqual([]);
    expect(parsed.artifact.extraExtensions).toEqual([]);
  });

  it("normalizes extraExtensions with a leading dot", () => {
    const parsed = parsePresentationCeilingArtifact({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: PRESENTATION_CHANGE_CLASS,
      extraExtensions: ["sql", ".CSHTML"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.artifact.extraExtensions).toEqual([".sql", ".cshtml"]);
  });

  it("refuses persistence changeClass", () => {
    const parsed = parsePresentationCeilingArtifact({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "persistence",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/changeClass must be presentation/);
  });

  it("refuses invalid JSON text", () => {
    const parsed = parseArtifactText("{not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/not valid JSON/);
  });

  it("refuses a missing schema", () => {
    const parsed = parsePresentationCeilingArtifact({ changeClass: PRESENTATION_CHANGE_CLASS });
    expect(parsed.ok).toBe(false);
  });
});
