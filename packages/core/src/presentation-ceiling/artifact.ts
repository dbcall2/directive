/**
 * Parse and list #5056 presentation-ceiling artifacts.
 */

import { execFileSync } from "node:child_process";
import { isCeilingArtifactRel, normalizeExtensionToken, normalizeRel } from "./paths.js";
import {
  PRESENTATION_CEILING_DIR,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
  type PresentationCeilingArtifact,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
}

export type ParseArtifactResult =
  | { readonly ok: true; readonly artifact: PresentationCeilingArtifact }
  | { readonly ok: false; readonly error: string };

/**
 * Parse one ceiling artifact. Returned failure, never throw.
 */
export function parsePresentationCeilingArtifact(raw: unknown): ParseArtifactResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "presentation-ceiling artifact must be a JSON object" };
  }
  if (raw.schema !== PRESENTATION_CEILING_SCHEMA) {
    return { ok: false, error: `schema must be ${PRESENTATION_CEILING_SCHEMA}` };
  }
  if (raw.changeClass !== PRESENTATION_CHANGE_CLASS) {
    return {
      ok: false,
      error: `changeClass must be ${PRESENTATION_CHANGE_CLASS} (persistence/backend are not this harvest)`,
    };
  }
  const allowlist = asStringArray(raw.allowlist).map((p) => normalizeRel(p));
  const extraExtensions = asStringArray(raw.extraExtensions)
    .map((e) => normalizeExtensionToken(e))
    .filter((e) => e.length > 0);
  let humanApproval: PresentationCeilingArtifact["humanApproval"];
  if (raw.humanApproval !== undefined) {
    if (!isRecord(raw.humanApproval)) {
      return { ok: false, error: "humanApproval must be an object when present" };
    }
    const kind = typeof raw.humanApproval.kind === "string" ? raw.humanApproval.kind.trim() : "";
    const actor = typeof raw.humanApproval.actor === "string" ? raw.humanApproval.actor.trim() : "";
    const mintedAt =
      typeof raw.humanApproval.mintedAt === "string" ? raw.humanApproval.mintedAt.trim() : "";
    if (kind.length === 0 || actor.length === 0 || mintedAt.length === 0) {
      return { ok: false, error: "humanApproval requires kind, actor, and mintedAt" };
    }
    humanApproval = {
      kind,
      actor,
      mintedAt,
      mintedVia:
        typeof raw.humanApproval.mintedVia === "string" ? raw.humanApproval.mintedVia : undefined,
    };
  }
  return {
    ok: true,
    artifact: {
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: PRESENTATION_CHANGE_CLASS,
      allowlist,
      extraExtensions,
      humanApproval,
    },
  };
}

export function parseArtifactText(text: string): ParseArtifactResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "presentation-ceiling artifact is not valid JSON" };
  }
  return parsePresentationCeilingArtifact(raw);
}

function runGit(projectRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function listFromMap(map: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, text] of map) {
    const posix = normalizeRel(rel);
    if (isCeilingArtifactRel(posix)) out.set(posix, text);
  }
  return out;
}

function listFromGit(
  projectRoot: string,
  ref: string,
  read: (rel: string) => string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  const ls = runGit(projectRoot, ["ls-tree", "-r", "--name-only", ref, PRESENTATION_CEILING_DIR]);
  if (ls === null || ls.length === 0) return out;
  for (const rel of ls
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)) {
    const posix = normalizeRel(rel);
    if (!isCeilingArtifactRel(posix)) continue;
    const text = read(posix);
    if (text !== null) out.set(posix, text);
  }
  return out;
}

export function listCeilingArtifactTexts(input: {
  readonly projectRoot: string;
  readonly ref: string;
  readonly injected?: ReadonlyMap<string, string>;
  readonly read?: (rel: string) => string | null;
}): Map<string, string> {
  if (input.injected !== undefined) return listFromMap(input.injected);
  const reader =
    input.read ??
    ((rel: string) => {
      const shown = runGit(input.projectRoot, ["show", `${input.ref}:${rel}`]);
      return shown;
    });
  return listFromGit(input.projectRoot, input.ref, reader);
}
