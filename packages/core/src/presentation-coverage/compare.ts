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
    if (!subset(he, be) || (br.length > 0 && (hr.length === 0 || !subset(hr, br))))
      return { kind: "weakening", armed: true, refuseWeakenOrRemove: true, artifactRels: rels };
    if (!subset(be, he) || (br.length === 0 && hr.length > 0) || !subset(br, hr))
      kind = "tightening";
  }
  if (removed)
    return { kind: "removal", armed: true, refuseWeakenOrRemove: true, artifactRels: rels };
  if (head.some((h) => !base.some((b) => b.rel === h.rel))) kind = "add-only";
  return { kind, armed: rels.length > 0, refuseWeakenOrRemove: false, artifactRels: rels };
}
