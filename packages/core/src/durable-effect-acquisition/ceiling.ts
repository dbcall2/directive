/**
 * Consume the #5056 presentation-ceiling artifact (#5080 item 8).
 * Arming follows #5079: add-only or tightening head restriction arms;
 * merge-base presence cannot be disarmed by head deletion or weakening.
 */
import {
  type CeilingLoad,
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_DIR_REL,
  PRESENTATION_CEILING_SCHEMA,
  type PresentationCeiling,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

function asStringArray(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

export function parsePresentationCeiling(raw: string): PresentationCeiling | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      error: `ceiling JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isRecord(parsed)) return { error: "ceiling JSON is not an object" };
  if (parsed.schema !== PRESENTATION_CEILING_SCHEMA) {
    return { error: `ceiling schema must be ${PRESENTATION_CEILING_SCHEMA}` };
  }
  if (parsed.changeClass !== "presentation") {
    return { error: "ceiling changeClass must be presentation" };
  }
  const admittedGlobalsRaw = parsed.admittedGlobals;
  let admittedGlobals: PresentationCeiling["admittedGlobals"];
  if (admittedGlobalsRaw !== undefined) {
    if (!Array.isArray(admittedGlobalsRaw)) return { error: "admittedGlobals must be an array" };
    const globals: Array<{ name: string; members?: readonly string[] }> = [];
    for (const g of admittedGlobalsRaw) {
      if (!isRecord(g) || typeof g.name !== "string")
        return { error: "admittedGlobals entries need name" };
      const members = asStringArray(g.members);
      if (g.members !== undefined && members === undefined)
        return { error: "admittedGlobals.members must be strings" };
      globals.push(members === undefined ? { name: g.name } : { name: g.name, members });
    }
    admittedGlobals = globals;
  }
  return {
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: "presentation",
    admittedOrigins: asStringArray(parsed.admittedOrigins),
    admittedPackages: asStringArray(parsed.admittedPackages),
    admittedGlobals,
    admittedPaths: asStringArray(parsed.admittedPaths),
    extraExtensions: asStringArray(parsed.extraExtensions),
    humanOrigin: parsed.humanOrigin === true,
  };
}

export function emptyAmendments(ceiling: PresentationCeiling | null): {
  readonly origins: readonly string[];
  readonly packages: readonly string[];
  readonly paths: readonly string[];
} {
  return {
    origins: ceiling?.admittedOrigins ?? [],
    packages: ceiling?.admittedPackages ?? [],
    paths: ceiling?.admittedPaths ?? [],
  };
}

function countList(v: readonly string[] | undefined): number {
  return v?.length ?? 0;
}

function sortedKey(v: readonly string[] | undefined): string {
  return JSON.stringify([...(v ?? [])].toSorted());
}

function globalsKey(g: PresentationCeiling["admittedGlobals"]): string {
  if (g === undefined) return "[]";
  return JSON.stringify(
    [...g]
      .map((entry) => ({
        name: entry.name,
        members: [...(entry.members ?? [])].toSorted(),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  );
}

/** Head is weaker when it admits more, or drops the restriction. */
export function ceilingIsWeaker(
  base: PresentationCeiling,
  head: PresentationCeiling | null,
): boolean {
  if (head === null) return true;
  if (countList(head.admittedOrigins) > countList(base.admittedOrigins)) return true;
  if (countList(head.admittedPackages) > countList(base.admittedPackages)) return true;
  if (countList(head.admittedPaths) > countList(base.admittedPaths)) return true;
  if (countList(head.extraExtensions) > countList(base.extraExtensions)) return true;
  return false;
}

/** Same-PR rewrite of any admitted list, including tightening. */
export function allowlistsDiffer(a: PresentationCeiling, b: PresentationCeiling): boolean {
  return (
    sortedKey(a.admittedOrigins) !== sortedKey(b.admittedOrigins) ||
    sortedKey(a.admittedPackages) !== sortedKey(b.admittedPackages) ||
    sortedKey(a.admittedPaths) !== sortedKey(b.admittedPaths) ||
    sortedKey(a.extraExtensions) !== sortedKey(b.extraExtensions) ||
    globalsKey(a.admittedGlobals) !== globalsKey(b.admittedGlobals)
  );
}

export function ceilingIsTightening(
  base: PresentationCeiling | null,
  head: PresentationCeiling | null,
): boolean {
  if (head === null) return false;
  if (base === null) return true;
  return ceilingIsWeaker(head, base);
}

export type Arming = {
  readonly armed: boolean;
  readonly reason: string;
  readonly samePrWeaken: boolean;
  readonly samePrAllowlistEdit: boolean;
  readonly base: PresentationCeiling | null;
  readonly head: PresentationCeiling | null;
  readonly rel: string | null;
};

export function evaluateArming(
  base: PresentationCeiling | null,
  head: PresentationCeiling | null,
  rel: string | null,
): Arming {
  if (base !== null) {
    const weaken = ceilingIsWeaker(base, head);
    return {
      armed: true,
      reason: "merge-base presentation ceiling",
      samePrWeaken: head === null || weaken,
      samePrAllowlistEdit: head !== null && allowlistsDiffer(base, head),
      base,
      head,
      rel,
    };
  }
  if (head !== null) {
    return {
      armed: true,
      reason: "add-only head presentation restriction",
      samePrWeaken: false,
      samePrAllowlistEdit: false,
      base,
      head,
      rel,
    };
  }
  return {
    armed: false,
    reason: "off-ceiling",
    samePrWeaken: false,
    samePrAllowlistEdit: false,
    base,
    head,
    rel,
  };
}

export function loadCeilingFromMap(files: ReadonlyMap<string, string | null>): CeilingLoad {
  const primary = files.get(PRESENTATION_CEILING_ARTIFACT_REL);
  if (typeof primary === "string") {
    const parsed = parsePresentationCeiling(primary);
    if ("error" in parsed) return { ok: false, detail: parsed.error };
    return { ok: true, ceiling: parsed, rel: PRESENTATION_CEILING_ARTIFACT_REL };
  }
  for (const [rel, text] of files) {
    const posix = rel.replace(/\\/g, "/");
    if (!posix.startsWith(`${PRESENTATION_CEILING_DIR_REL}/`) || !posix.endsWith(".json")) continue;
    if (typeof text !== "string") continue;
    const parsed = parsePresentationCeiling(text);
    if ("error" in parsed) return { ok: false, detail: `${rel}: ${parsed.error}` };
    return { ok: true, ceiling: parsed, rel };
  }
  return { ok: true, ceiling: null, rel: null };
}

export function defaultCeilingRel(): string {
  return PRESENTATION_CEILING_ARTIFACT_REL;
}
