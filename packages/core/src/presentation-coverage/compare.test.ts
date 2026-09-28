import { describe, expect, it } from "vitest";
import { compareRestrictions, effectiveExtensions } from "./compare.js";
import type { LoadedArtifact, PresentationCeilingArtifact } from "./types.js";

const a = (props: Partial<PresentationCeilingArtifact> = {}): LoadedArtifact => ({
  rel: ".deft/presentation-ceiling.json",
  artifact: {
    hasExtensionRestriction: props.allowedExtensions !== undefined,
    allowedExtensions: [],
    componentRoots: [],
    extensionAmendment: null,
    removalStamp: null,
    ...props,
  },
});
describe("restriction comparison", () => {
  it("arms head-only restrictions independently of diff purity", () =>
    expect(compareRestrictions([], [a()])).toMatchObject({ kind: "add-only", armed: true }));
  it("leaves true absence off-ceiling", () =>
    expect(compareRestrictions([], [])).toMatchObject({ kind: "off-ceiling", armed: false }));
  it("recognizes unchanged base and narrowing", () => {
    expect(compareRestrictions([a()], [a()])).toHaveProperty("kind", "unchanged-base");
    expect(
      compareRestrictions(
        [a()],
        [a({ allowedExtensions: [".html"], componentRoots: ["public/**"] })],
      ),
    ).toHaveProperty("kind", "tightening");
  });
  it("refuses removal, empty-list widening, root widening and new extensions", () => {
    expect(compareRestrictions([a()], [])).toMatchObject({
      kind: "removal",
      refuseWeakenOrRemove: true,
    });
    expect(compareRestrictions([a({ allowedExtensions: [".html"] })], [a()])).toHaveProperty(
      "kind",
      "weakening",
    );
    expect(compareRestrictions([a({ componentRoots: ["public/**"] })], [a()])).toHaveProperty(
      "kind",
      "weakening",
    );
    expect(
      compareRestrictions(
        [a()],
        [a({ extensionAmendment: { extensions: [".sql"], humanApproval: {} } })],
      ),
    ).toHaveProperty("kind", "weakening");
  });
  it("an empty explicit allowlist is a restriction and removing it is weakening", () => {
    expect(effectiveExtensions(a({ allowedExtensions: [] }).artifact)).toEqual([]);
    expect(compareRestrictions([a()], [a({ allowedExtensions: [] })])).toHaveProperty(
      "kind",
      "tightening",
    );
    expect(compareRestrictions([a({ allowedExtensions: [] })], [a()])).toHaveProperty(
      "kind",
      "weakening",
    );
  });
  it("an allowlist cannot grant a new extension", () =>
    expect(effectiveExtensions(a({ allowedExtensions: [".sql"] }).artifact)).toEqual([]));
});
