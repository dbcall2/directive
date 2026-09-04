import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isDeclaredLiveProcedureExclusion,
  isLiveProcedureSectionExcluded,
  LIVE_PROCEDURE_EXCLUSIONS,
  parseMarkdownHeading,
} from "./live-procedure-exclusions.js";

const UPGRADING = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../content/UPGRADING.md"),
  "utf8",
);

describe("C3 live-procedure exclusion declaration (#3602)", () => {
  it("carries history, example, and prohibition by declaration", () => {
    const kinds = new Set(LIVE_PROCEDURE_EXCLUSIONS.map((e) => e.kind));
    expect(kinds.has("history")).toBe(true);
    expect(kinds.has("example")).toBe(true);
    expect(kinds.has("prohibition")).toBe(true);
  });

  it("declares github.md as a prohibition, not a pattern skip", () => {
    const github = LIVE_PROCEDURE_EXCLUSIONS.find((e) => e.path === "scm/github.md");
    expect(github?.kind).toBe("prohibition");
    expect(isDeclaredLiveProcedureExclusion("scm/github.md")).toBe(true);
    expect(isDeclaredLiveProcedureExclusion("skills/demo/SKILL.md")).toBe(false);
  });

  it("requires a reason on every declared exclusion", () => {
    for (const entry of LIVE_PROCEDURE_EXCLUSIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.path.includes("\\")).toBe(false);
    }
  });

  it("retargets UPGRADING.md to named frozen sections, not history/archive (#4100)", () => {
    expect(LIVE_PROCEDURE_EXCLUSIONS.some((entry) => entry.path.includes("history/archive"))).toBe(
      false,
    );
    const upgrading = LIVE_PROCEDURE_EXCLUSIONS.filter((entry) => entry.path === "UPGRADING.md");
    expect(upgrading.length).toBeGreaterThan(1);
    for (const entry of upgrading) {
      expect(entry.kind).toBe("history");
      expect(entry.section && entry.section.length > 0).toBe(true);
    }
    expect(isDeclaredLiveProcedureExclusion("UPGRADING.md")).toBe(false);
    expect(
      isLiveProcedureSectionExcluded(
        "UPGRADING.md",
        "Frozen pre-v0.20 document-model migration (#2068)",
      ),
    ).toBe(true);
    expect(isLiveProcedureSectionExcluded("UPGRADING.md", "Current path")).toBe(false);
    expect(
      isLiveProcedureSectionExcluded("UPGRADING.md", "Canonical upgrade — npm (v0.55.1+)"),
    ).toBe(false);
    expect(parseMarkdownHeading("## Current path")).toEqual({ level: 2, title: "Current path" });
    expect(UPGRADING).toContain("## Current path");
    for (const entry of upgrading) {
      expect(UPGRADING, `missing heading for ${entry.section}`).toContain(entry.section as string);
    }
    for (const heading of [
      "### Corporate or mirrored npm registry",
      "## Canonical upgrade — npm (v0.55.1+)",
      "### Frozen pre-v0.20 document-model migration (#2068)",
      "## Node runtime (#1828 / #1530)",
      "### xBRIEF rename (#2034 / #2110 / #2907)",
      "## Big-jump triage — multi-version upgrades (start here)",
    ]) {
      expect(UPGRADING, `missing compatible heading ${heading}`).toContain(heading);
    }
  });
});
