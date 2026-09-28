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

it.each([
  ["db/**", "db/narrow/**", "tightening"],
  ["db/**", "db/narrow", "tightening"],
  ["db", "db/**", "tightening"],
  ["db/**", "db/", "unchanged-base"],
  ["**", "db/**", "tightening"],
  ["db/**", "db", "weakening"],
  ["ui.ts/**", "ui.ts", "weakening"],
  ["db/narrow/**", "db/**", "weakening"],
  ["db/**", "db2/**", "weakening"],
  ["db/**", "other/**", "weakening"],
  ["db/*/sql/**", "db/narrow/sql/**", "weakening"],
  ["db/**", "db/*/**", "weakening"],
  ["db/*/**", "db/*/**", "unchanged-base"],
])("compares root %s to %s conservatively", (base, head, kind) => {
  expect(
    compareRestrictions([a({ componentRoots: [base] })], [a({ componentRoots: [head] })]),
  ).toHaveProperty("kind", kind);
});
it("requires every candidate root to stay within an existing root", () => {
  expect(
    compareRestrictions(
      [a({ componentRoots: ["db/**", "ui/**"] })],
      [a({ componentRoots: ["db/narrow/**", "ui/components/**"] })],
    ),
  ).toHaveProperty("kind", "tightening");
  expect(
    compareRestrictions(
      [a({ componentRoots: ["db/**"] })],
      [a({ componentRoots: ["db/narrow/**", "outside/**"] })],
    ),
  ).toHaveProperty("kind", "weakening");
});
