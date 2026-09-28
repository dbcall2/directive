/** #5056 public record shapes, with #5080 typed durable-effect amendments. */
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import {
  type CeilingLoad,
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_SCHEMA,
  type PresentationCeiling,
} from "./types.js";

const PLAN_KEY = "x-directive/changeClass";
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
}
export function isCeilingCandidatePath(path: string): boolean {
  return (
    path === PRESENTATION_CEILING_ARTIFACT_REL ||
    path.endsWith("/presentation-ceiling.json") ||
    /^xbrief\/(active|pending|proposed)\/.*\.xbrief\.json$/.test(path)
  );
}
function payload(raw: Record<string, unknown>): unknown {
  if ("changeClass" in raw) return raw;
  if (!record(raw.plan)) return null;
  if (PLAN_KEY in raw.plan) return raw.plan[PLAN_KEY];
  return record(raw.plan.metadata) ? (raw.plan.metadata[PLAN_KEY] ?? null) : null;
}
function decode(raw: unknown): PresentationCeiling | null | { error: string } {
  if (raw === null || raw === undefined) return null;
  if (raw === "presentation")
    return { schema: PRESENTATION_CEILING_SCHEMA, changeClass: "presentation" };
  if (typeof raw === "string") return null; // other #5056 change classes do not arm
  if (!record(raw)) return { error: "change-class record must be a string or object" };
  if (raw.changeClass !== "presentation")
    return typeof raw.changeClass === "string"
      ? null
      : { error: "ceiling changeClass must be a string" };
  if (raw.schema !== undefined && raw.schema !== PRESENTATION_CEILING_SCHEMA)
    return { error: `ceiling schema must be ${PRESENTATION_CEILING_SCHEMA}` };
  const known = new Set([
    "schema",
    "changeClass",
    "admittedOrigins",
    "admittedPackages",
    "admittedGlobals",
    "admittedPaths",
    "humanApproval",
    "humanOrigin",
    "allowedExtensions",
    "allowlist",
    "componentRoots",
    "extensionAmendment",
    "removalStamp",
  ]);
  for (const key of Object.keys(raw))
    if (!known.has(key)) return { error: `unsupported ceiling field ${key}` };
  for (const key of [
    "admittedOrigins",
    "admittedPackages",
    "admittedPaths",
    "allowedExtensions",
    "allowlist",
    "componentRoots",
  ])
    if (raw[key] !== undefined && !strings(raw[key]))
      return { error: `${key} must be an array of nonempty strings` };
  if (raw.humanOrigin !== undefined && typeof raw.humanOrigin !== "boolean")
    return { error: "humanOrigin must be boolean (it does not grant authority)" };
  const origins = raw.admittedOrigins as string[] | undefined;
  if (origins)
    for (const origin of origins) {
      try {
        const url = new URL(origin);
        if (url.origin !== origin || url.origin === "null")
          return { error: `admittedOrigins entry must be a serialized origin: ${origin}` };
      } catch {
        return { error: `invalid admitted origin ${origin}` };
      }
    }
  const paths = raw.admittedPaths as string[] | undefined;
  if (
    paths?.some(
      (p) =>
        p.startsWith("/") ||
        p.includes("\\") ||
        p.split("/").some((part) => part === ".." || part === "." || part === ""),
    )
  )
    return { error: "admittedPaths must be exact normalized repository-relative paths" };
  let globals: PresentationCeiling["admittedGlobals"];
  if (raw.admittedGlobals !== undefined) {
    if (!Array.isArray(raw.admittedGlobals)) return { error: "admittedGlobals must be an array" };
    const out: Array<{ name: string; members: readonly string[] }> = [];
    for (const g of raw.admittedGlobals) {
      if (
        !record(g) ||
        typeof g.name !== "string" ||
        !/^[A-Za-z_$][\w$]*$/.test(g.name) ||
        !strings(g.members) ||
        Object.keys(g).some((k) => k !== "name" && k !== "members")
      )
        return { error: "admittedGlobals entries require name and explicit members arrays" };
      out.push({ name: g.name, members: g.members });
    }
    globals = out;
  }
  let humanApproval: PresentationCeiling["humanApproval"];
  if (raw.humanApproval !== undefined) {
    const a = raw.humanApproval;
    if (
      !record(a) ||
      typeof a.kind !== "string" ||
      typeof a.actor !== "string" ||
      typeof a.mintedAt !== "string" ||
      !Number.isFinite(Date.parse(a.mintedAt)) ||
      (a.mintedVia !== undefined && typeof a.mintedVia !== "string")
    )
      return { error: "malformed humanApproval" };
    humanApproval = {
      kind: a.kind,
      actor: a.actor,
      mintedAt: a.mintedAt,
      ...(typeof a.mintedVia === "string" ? { mintedVia: a.mintedVia } : {}),
    };
    if (!isHumanApprovalStamp(humanApproval))
      return { error: "humanApproval must name a human actor and kind" };
  }
  return {
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: "presentation",
    admittedOrigins: origins,
    admittedPackages: raw.admittedPackages as string[] | undefined,
    admittedPaths: paths,
    admittedGlobals: globals,
    humanApproval,
    humanOrigin: raw.humanOrigin === true,
  };
}
export function parsePresentationCeiling(text: string): PresentationCeiling | { error: string } {
  try {
    const raw: unknown = JSON.parse(text);
    if (!record(raw)) return { error: "ceiling JSON is not an object" };
    return decode(payload(raw)) ?? { error: "no presentation change-class record" };
  } catch (err) {
    return { error: `ceiling JSON parse failed: ${String(err)}` };
  }
}
export function emptyAmendments(ceiling: PresentationCeiling | null): {
  origins: readonly string[];
  packages: readonly string[];
  paths: readonly string[];
  globals: NonNullable<PresentationCeiling["admittedGlobals"]>;
} {
  if (!ceiling?.humanApproval) return { origins: [], packages: [], paths: [], globals: [] };
  return {
    origins: ceiling.admittedOrigins ?? [],
    packages: ceiling.admittedPackages ?? [],
    paths: ceiling.admittedPaths ?? [],
    globals: ceiling.admittedGlobals ?? [],
  };
}
function key(c: PresentationCeiling): string {
  return JSON.stringify([
    ...[c.admittedOrigins, c.admittedPackages, c.admittedPaths].map((v) => [...(v ?? [])].sort()),
    [...(c.admittedGlobals ?? [])].map((g) => [g.name, [...(g.members ?? [])].sort()]).sort(),
    c.humanApproval ?? null,
  ]);
}
export function allowlistsDiffer(a: PresentationCeiling, b: PresentationCeiling): boolean {
  return key(a) !== key(b);
}
export function ceilingIsWeaker(
  base: PresentationCeiling,
  head: PresentationCeiling | null,
): boolean {
  return (
    head === null ||
    ["admittedOrigins", "admittedPackages", "admittedPaths"].some((field) => {
      const k = field as "admittedOrigins" | "admittedPackages" | "admittedPaths";
      return (head[k] ?? []).some((v) => !(base[k] ?? []).includes(v));
    }) ||
    (head.admittedGlobals ?? []).some((g) => {
      const b = base.admittedGlobals?.find((v) => v.name === g.name);
      return !b || (g.members ?? []).some((m) => !(b.members ?? []).includes(m));
    })
  );
}
export function ceilingIsTightening(
  base: PresentationCeiling | null,
  head: PresentationCeiling | null,
): boolean {
  return head !== null && (base === null || ceilingIsWeaker(head, base));
}
export function evaluateArming(
  base: PresentationCeiling | null,
  head: PresentationCeiling | null,
  rel: string | null,
) {
  return {
    armed: base !== null || head !== null,
    reason: base
      ? "merge-base presentation ceiling"
      : head
        ? "add-only head presentation restriction"
        : "off-ceiling",
    samePrWeaken: base !== null && ceilingIsWeaker(base, head),
    samePrAllowlistEdit: base !== null && head !== null && allowlistsDiffer(base, head),
    base,
    head,
    rel,
  };
}
/** Intersect grants: each applicable ceiling remains a restriction. */
export function combineCeilings(
  ceilings: readonly PresentationCeiling[],
): PresentationCeiling | null {
  const first = ceilings[0];
  if (!first) return null;
  const grants = ceilings.map(emptyAmendments);
  const intersect = (field: "origins" | "packages" | "paths"): string[] =>
    [...(grants[0]?.[field] ?? [])].filter((v) => grants.every((g) => g[field].includes(v)));
  const globals = (grants[0]?.globals ?? []).flatMap((g) => {
    if (!grants.every((a) => a.globals.some((x) => x.name === g.name))) return [];
    return [
      {
        name: g.name,
        members: (g.members ?? []).filter((m) =>
          grants.every((a) => a.globals.find((x) => x.name === g.name)?.members?.includes(m)),
        ),
      },
    ];
  });
  return {
    ...first,
    admittedOrigins: intersect("origins"),
    admittedPackages: intersect("packages"),
    admittedPaths: intersect("paths"),
    admittedGlobals: globals,
  };
}
export function loadCeilingFromMap(files: ReadonlyMap<string, string | null>): CeilingLoad {
  const records = new Map<string, PresentationCeiling>();
  for (const [rel, text] of files) {
    if (text === null || !isCeilingCandidatePath(rel)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      return { ok: false, detail: `${rel}: ceiling JSON parse failed: ${String(err)}` };
    }
    if (!record(raw)) return { ok: false, detail: `${rel}: expected JSON object` };
    const candidate = payload(raw);
    const parsed = decode(candidate);
    if (parsed && "error" in parsed) return { ok: false, detail: `${rel}: ${parsed.error}` };
    if (parsed) records.set(rel, parsed);
    else if (rel.endsWith("/presentation-ceiling.json"))
      return { ok: false, detail: `${rel}: no presentation change-class record` };
  }
  return {
    ok: true,
    ceiling: combineCeilings([...records.values()]),
    rel: records.keys().next().value ?? null,
    records,
  };
}
export function defaultCeilingRel(): string {
  return PRESENTATION_CEILING_ARTIFACT_REL;
}
