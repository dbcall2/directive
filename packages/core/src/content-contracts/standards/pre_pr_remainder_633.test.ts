import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

/**
 * Leftover-deliver remainder for #633 (lean 5784448698).
 * Tiers 1-3 stay withdrawn. This suite pins the three Bound-remedy items.
 */
describe("pre-PR remainder #633", () => {
  it("PR template checklist names detectors and keeps Post-Merge out of checkbox syntax", () => {
    const template = readText(".github/PULL_REQUEST_TEMPLATE.md");
    const postMergeIdx = template.indexOf("## Post-Merge");
    expect(postMergeIdx).toBeGreaterThan(-1);
    const checklist = template.slice(0, postMergeIdx);
    const postMerge = template.slice(postMergeIdx);
    expect(checklist).toContain("verify:scope-provenance");
    expect(checklist).toContain("verify:changelog-unreleased");
    expect(checklist).toMatch(/- \[ \] `\/deft:change/);
    expect(checklist).toMatch(/- \[ \] `CHANGELOG\.md`/);
    expect(checklist).toMatch(/N\/A for <3 file changes/);
    expect(checklist).toMatch(/N\/A for test-only \/ CI-only changes/);
    expect(checklist).not.toMatch(/Tests pass locally/);
    expect(postMerge).not.toMatch(/^- \[ \]/m);
    expect(postMerge).toContain("gh api repos/<owner>/<repo>/issues/<N>");
    expect(postMerge).toContain("Merge gate (task check)");
  });

  it("does not add a second Unreleased changelog language", () => {
    const verify = readText("tasks/verify.yml");
    const blockStart = verify.indexOf("changelog-unreleased:");
    expect(blockStart).toBeGreaterThan(-1);
    const rest = verify.slice(blockStart);
    const nextTask = rest.search(/\n {2}[a-z][a-z0-9-]*:/);
    const block = nextTask === -1 ? rest : rest.slice(0, nextTask);
    expect(block).toContain("changelog-check");
    expect(block).toContain("--against-merge-base");
    expect(block).not.toMatch(/ENGINE_CMD: '(?!changelog-check)/);
  });
});
