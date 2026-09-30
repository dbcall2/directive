import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPackedDepositBrokenLinks } from "./classify-packed-link-residuals.js";

const created: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("classifyPackedDepositBrokenLinks (#4890)", () => {
  it("returns empty sets when the staged pack has no broken links", () => {
    expect(
      classifyPackedDepositBrokenLinks({ broken: [], repoRoot: tempDir("pack-empty-") }),
    ).toEqual({ unexpected: [], residualTargets: [] });
  });

  it("marks a pack-mapped shippable miss as unexpected", () => {
    const repoRoot = tempDir("pack-unexp-");
    writeFileSync(join(repoRoot, "main.md"), "# main\n", "utf8");
    const measure = classifyPackedDepositBrokenLinks({
      repoRoot,
      broken: [{ file: "meta/security.md", line: 8, target: "../../main.md" }],
    });
    expect(measure.unexpected).toEqual(["meta/security.md:8 -> ../../main.md"]);
    expect(measure.residualTargets).toEqual([]);
  });

  it("classifies a broken already-rewritten pack href against the source path", () => {
    const repoRoot = tempDir("pack-rewritten-");
    writeFileSync(join(repoRoot, "main.md"), "# main\n", "utf8");
    const measure = classifyPackedDepositBrokenLinks({
      repoRoot,
      broken: [{ file: "meta/security.md", line: 8, target: "../main.md" }],
    });
    expect(measure.unexpected).toEqual(["meta/security.md:8 -> ../main.md"]);
    expect(measure.residualTargets).toEqual([]);
  });

  it("keeps an unmapped ADR target as a residual", () => {
    const repoRoot = tempDir("pack-adr-");
    mkdirSync(join(repoRoot, "docs", "decisions"), { recursive: true });
    writeFileSync(
      join(repoRoot, "docs", "decisions", "ADR-003-a2a-nuclear-family-topology.md"),
      "# adr\n",
      "utf8",
    );
    const target = "../../docs/decisions/ADR-003-a2a-nuclear-family-topology.md";
    const measure = classifyPackedDepositBrokenLinks({
      repoRoot,
      broken: [{ file: "meta/security.md", line: 11, target }],
    });
    expect(measure.unexpected).toEqual([]);
    expect(measure.residualTargets).toEqual([target]);
  });

  it("keeps a pack-mapped but source-missing target as a residual", () => {
    const repoRoot = tempDir("pack-missing-");
    writeFileSync(join(repoRoot, "main.md"), "# main\n", "utf8");
    const measure = classifyPackedDepositBrokenLinks({
      repoRoot,
      broken: [{ file: "main.md", line: 2, target: "./content/coding/gone.md" }],
    });
    expect(measure.unexpected).toEqual([]);
    expect(measure.residualTargets).toEqual(["./content/coding/gone.md"]);
  });
});
