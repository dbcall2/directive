/** Restriction-first comparison. Head can tighten/arm, never grant authority.
 * Builtin restrictions intersect; admission separately binds stamped extra
 * dialects to the current story and path.
 */
import {
  BUILTIN_PRESENTATION_EXTENSIONS,
  type LoadedArtifact,
  type PresentationCeilingArtifact,
  type RestrictionCompare,
} from "./types.js";
export function effectiveExtensions(art: PresentationCeilingArtifact): readonly string[] {
  const builtins = !art.hasExtensionRestriction
    ? [...BUILTIN_PRESENTATION_EXTENSIONS]
    : BUILTIN_PRESENTATION_EXTENSIONS.filter((e) => art.allowedExtensions.includes(e));
  const extras = (art.extensionAmendment?.extensions ?? []).filter(
    (e) => !(BUILTIN_PRESENTATION_EXTENSIONS as readonly string[]).includes(e),
  );
  return [...new Set([...builtins, ...extras])];
}
function subset(inner: readonly string[], outer: readonly string[]): boolean {
  return inner.every((x) => outer.includes(x));
}
/** Prove containment only for literal roots and their recursive subtrees.
 * A bare root includes the exact path; root/** includes only descendants.
 * Other glob relationships stay unknown unless the patterns are identical.
 */
function rootSubset(inner: readonly string[], outer: readonly string[]): boolean {
  const literal = (root: string) => {
    const descendantsOnly = root.endsWith("/**") || root.endsWith("/");
    const prefix = root.replace(/\/\*\*$/, "").replace(/\/$/, "");
    return prefix.length > 0 && !/[?*[\]{}]/.test(prefix) ? { prefix, descendantsOnly } : null;
  };
  return inner.every((root) =>
    outer.some((parent) => {
      if (root === parent || parent === "**") return true;
      const child = literal(root),
        base = literal(parent);
      if (child === null || base === null) return false;
      return (
        child.prefix.startsWith(`${base.prefix}/`) ||
        (child.prefix === base.prefix && (!base.descendantsOnly || child.descendantsOnly))
      );
    }),
  );
}
export function compareRestrictions(
  base: readonly LoadedArtifact[],
  head: readonly LoadedArtifact[],
): RestrictionCompare {
  const rels = [...new Set([...base, ...head].map((a) => a.rel))].sort();
  let kind: RestrictionCompare["kind"] =
    rels.length === 0 ? "off-ceiling" : base.length === 0 ? "add-only" : "unchanged-base";
  let removed = false;
  for (const b of base) {
    const h = head.find((a) => a.rel === b.rel);
    if (h === undefined) {
      removed = true;
      continue;
    }
    const be = effectiveExtensions(b.artifact),
      he = effectiveExtensions(h.artifact);
    const br = b.artifact.componentRoots,
      hr = h.artifact.componentRoots;
    if (!subset(he, be) || (br.length > 0 && (hr.length === 0 || !rootSubset(hr, br))))
      return { kind: "weakening", armed: true, refuseWeakenOrRemove: true, artifactRels: rels };
    if (!subset(be, he) || (br.length === 0 && hr.length > 0) || !rootSubset(br, hr))
      kind = "tightening";
  }
  if (removed)
    return { kind: "removal", armed: true, refuseWeakenOrRemove: true, artifactRels: rels };
  if (head.some((h) => !base.some((b) => b.rel === h.rel))) kind = "add-only";
  return { kind, armed: rels.length > 0, refuseWeakenOrRemove: false, artifactRels: rels };
}
