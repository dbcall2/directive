import { describe, expect, it } from "vitest";
import { compareRestrictions, loadArtifactsFromTexts } from "./compare.js";
import { PRESENTATION_CEILING_SCHEMA } from "./types.js";

function artifact(extra?: { allowlist?: string[]; extraExtensions?: string[] }): string {
  return `${JSON.stringify({
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: "presentation",
    allowlist: extra?.allowlist ?? [],
    extraExtensions: extra?.extraExtensions ?? [],
  })}\n`;
}

describe("compareRestrictions (#5079 / #5056)", () => {
  it("is off-ceiling with no artifacts", () => {
    const r = compareRestrictions([], []);
    expect(r.armed).toBe(false);
    expect(r.kind).toBe("off-ceiling");
    expect(r.refuseWeakenOrRemove).toBe(false);
  });

  it("arms from a head-only add-only restriction regardless of purity", () => {
    const head = loadArtifactsFromTexts(
      new Map([[".deft/presentation-ceilings/story.json", artifact()]]),
    );
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    const r = compareRestrictions([], head.loaded);
    expect(r.armed).toBe(true);
    expect(r.kind).toBe("add-only");
    expect(r.refuseWeakenOrRemove).toBe(false);
  });

  it("arms from an unchanged merge-base restriction", () => {
    const texts = new Map([[".deft/presentation-ceilings/story.json", artifact()]]);
    const base = loadArtifactsFromTexts(texts);
    const head = loadArtifactsFromTexts(texts);
    expect(base.ok && head.ok).toBe(true);
    if (!base.ok || !head.ok) return;
    const r = compareRestrictions(base.loaded, head.loaded);
    expect(r.armed).toBe(true);
    expect(r.kind).toBe("unchanged-base");
  });

  it("refuses same-PR weaken even with a head stamp", () => {
    const base = loadArtifactsFromTexts(
      new Map([[".deft/presentation-ceilings/story.json", artifact({ extraExtensions: [] })]]),
    );
    const head = loadArtifactsFromTexts(
      new Map([
        [".deft/presentation-ceilings/story.json", artifact({ extraExtensions: [".sql"] })],
      ]),
    );
    expect(base.ok && head.ok).toBe(true);
    if (!base.ok || !head.ok) return;
    const r = compareRestrictions(base.loaded, head.loaded);
    expect(r.armed).toBe(true);
    expect(r.kind).toBe("weakening");
    expect(r.refuseWeakenOrRemove).toBe(true);
  });

  it("refuses removal of a merge-base artifact", () => {
    const base = loadArtifactsFromTexts(
      new Map([[".deft/presentation-ceilings/story.json", artifact()]]),
    );
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const r = compareRestrictions(base.loaded, []);
    expect(r.refuseWeakenOrRemove).toBe(true);
    expect(r.kind).toBe("removal");
    expect(r.armed).toBe(true);
  });

  it("arms tightening extraExtensions", () => {
    const base = loadArtifactsFromTexts(
      new Map([
        [
          ".deft/presentation-ceilings/story.json",
          artifact({ extraExtensions: [".sql", ".cshtml"] }),
        ],
      ]),
    );
    const head = loadArtifactsFromTexts(
      new Map([
        [".deft/presentation-ceilings/story.json", artifact({ extraExtensions: [".sql"] })],
      ]),
    );
    expect(base.ok && head.ok).toBe(true);
    if (!base.ok || !head.ok) return;
    const r = compareRestrictions(base.loaded, head.loaded);
    expect(r.kind).toBe("tightening");
    expect(r.armed).toBe(true);
    expect(r.refuseWeakenOrRemove).toBe(false);
  });
});
