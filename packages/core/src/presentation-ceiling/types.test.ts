import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESENTATION_EXTS,
  GATE_ID,
  GATE_TOOLING_PREFIXES,
  LOADER_NAMES,
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_PLAN_KEY,
  PRESENTATION_CEILING_REMEDIATION,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
} from "./types.js";

describe("presentation-ceiling types (#5056)", () => {
  it("keeps the built-in presentation set at html/jsx/tsx plus css", () => {
    expect([...BUILTIN_PRESENTATION_EXTS].sort()).toEqual([".css", ".html", ".jsx", ".tsx"]);
    expect(BUILTIN_PRESENTATION_EXTS).not.toContain(".js");
    expect(BUILTIN_PRESENTATION_EXTS).not.toContain(".ts");
    expect(BUILTIN_PRESENTATION_EXTS).not.toContain(".sql");
    expect(BUILTIN_PRESENTATION_EXTS).not.toContain(".scss");
  });

  it("names the sibling gate and durable artifact", () => {
    expect(GATE_ID).toBe("verify:presentation-ceiling");
    expect(PRESENTATION_CHANGE_CLASS).toBe("presentation");
    expect(PRESENTATION_CEILING_SCHEMA).toBe("deft.presentation-ceiling.v1");
    expect(PRESENTATION_CEILING_PLAN_KEY).toBe("x-directive/changeClass");
    expect(PRESENTATION_CEILING_ARTIFACT_REL).toBe(".deft/presentation-ceiling.json");
  });

  it("lists gate-tooling prefixes that include the sibling implementation", () => {
    expect(GATE_TOOLING_PREFIXES).toContain("packages/core/src/presentation-ceiling/");
    expect(GATE_TOOLING_PREFIXES).toContain("packages/core/src/intent-constraint/");
    expect(GATE_TOOLING_PREFIXES).toContain("packages/cli/src/verify-presentation-ceiling.ts");
  });

  it("treats loader-output consumption as a named reference surface", () => {
    expect(LOADER_NAMES).toEqual([
      "readApprovedScopeRecord",
      "loadRecord",
      "listApprovedScopeRecords",
    ]);
    expect(PRESENTATION_CEILING_REMEDIATION).toMatch(/N\/A/);
    expect(PRESENTATION_CEILING_REMEDIATION).toMatch(/#5059/);
  });
});
