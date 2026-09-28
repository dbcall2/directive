/**
 * Base-versus-head restriction compare (#5056 item 6 / #5079 item 3).
 *
 * Head may contribute add-only or tightening `changeClass: presentation`
 * restrictions. Weakening and removal refuse; a head stamp cannot authorize
 * them. Arming does not require #5056 item-6 purity.
 */

import { parseArtifactText } from "./artifact.js";
import type { PresentationCeilingArtifact, RestrictionCompare, RestrictionKind } from "./types.js";

export interface LoadedArtifact {
  readonly rel: string;
  readonly artifact: PresentationCeilingArtifact;
}

export type LoadArtifactsResult =
  | { readonly ok: true; readonly loaded: readonly LoadedArtifact[] }
  | { readonly ok: false; readonly error: string };

export function loadArtifactsFromTexts(texts: ReadonlyMap<string, string>): LoadArtifactsResult {
  const loaded: LoadedArtifact[] = [];
  for (const [rel, text] of [...texts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = parseArtifactText(text);
    if (!parsed.ok) {
      return { ok: false, error: `${rel}: ${parsed.error}` };
    }
    loaded.push({ rel, artifact: parsed.artifact });
  }
  return { ok: true, loaded };
}

function isSubset(inner: readonly string[], outer: readonly string[]): boolean {
  const set = new Set(outer);
  return inner.every((x) => set.has(x));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function restrictionDelta(
  base: PresentationCeilingArtifact | undefined,
  head: PresentationCeilingArtifact | undefined,
): RestrictionKind {
  if (base === undefined && head === undefined) return "off-ceiling";
  if (base === undefined && head !== undefined) return "add-only";
  if (base !== undefined && head === undefined) return "removal";
  if (base === undefined || head === undefined) return "off-ceiling";
  const allowTighter =
    isSubset(head.allowlist, base.allowlist) && !sameSet(head.allowlist, base.allowlist);
  const extTighter =
    isSubset(head.extraExtensions, base.extraExtensions) &&
    !sameSet(head.extraExtensions, base.extraExtensions);
  const allowWider = !isSubset(head.allowlist, base.allowlist);
  const extWider = !isSubset(head.extraExtensions, base.extraExtensions);
  if (allowWider || extWider) return "weakening";
  if (allowTighter || extTighter) return "tightening";
  return "unchanged-base";
}

/**
 * Compare every artifact rel present on base or head.
 * Armed from any add-only or tightening head restriction, or any base restriction.
 */
export function compareRestrictions(
  baseLoaded: readonly LoadedArtifact[],
  headLoaded: readonly LoadedArtifact[],
): RestrictionCompare {
  const baseByRel = new Map(baseLoaded.map((a) => [a.rel, a.artifact]));
  const headByRel = new Map(headLoaded.map((a) => [a.rel, a.artifact]));
  const rels = [...new Set([...baseByRel.keys(), ...headByRel.keys()])].sort();
  if (rels.length === 0) {
    return {
      kind: "off-ceiling",
      armed: false,
      refuseWeakenOrRemove: false,
      artifactRels: [],
    };
  }
  let refuseWeakenOrRemove = false;
  let armed = false;
  let kind: RestrictionKind = "off-ceiling";
  const rank: Record<RestrictionKind, number> = {
    "off-ceiling": 0,
    "unchanged-base": 1,
    "add-only": 2,
    tightening: 3,
    weakening: 4,
    removal: 5,
  };
  for (const rel of rels) {
    const delta = restrictionDelta(baseByRel.get(rel), headByRel.get(rel));
    if (delta === "weakening" || delta === "removal") refuseWeakenOrRemove = true;
    if (delta === "add-only" || delta === "tightening" || delta === "unchanged-base") {
      armed = true;
    }
    if (baseByRel.has(rel)) armed = true;
    if (rank[delta] > rank[kind]) kind = delta;
  }
  if (refuseWeakenOrRemove) armed = true;
  return {
    kind,
    armed,
    refuseWeakenOrRemove,
    artifactRels: rels,
  };
}
