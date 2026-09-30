/**
 * Pure stdin → payload parse for hook-dispatch (#2734 / #2738 / #2950).
 * No process I/O — operates on an already-read string.
 */

import { isApplyPatchTool } from "../tools.js";
import {
  fieldString,
  firstString,
  landProcessOnlyFlagOnToolInput,
  record,
  toolInputRecord,
} from "./payload.js";
import type { ParsedHookPayload } from "./types.js";

const UTF8_BOM = "\uFEFF";
const APPLY_PATCH_BEGIN_MARKER = "*** Begin Patch";
const APPLY_PATCH_END_MARKER = "*** End Patch";
/** Single-file Add/Update only — other *** … File: ops must fail closed (#2738 Greptile). */
const APPLY_PATCH_MUTATION_LINE_RE =
  /^\*\*\* (Add File|Update File|Delete File|Move File|Rename File): (.+)$/gm;
/**
 * Canonical apply_patch spells a rename as `*** Update File:` followed by
 * `*** Move to:`. The destination is a mutation target in its own right, so it
 * must reach root admission. Synthesis refuses when applyPatchMutationPaths
 * reports more than one unique path, so a Move-to destination is not dropped
 * from the single-target contract (#3614 / #3794).
 */
const APPLY_PATCH_MOVE_DESTINATION_RE = /^\*\*\* Move to: (.+)$/gm;

export function stripUtf8Bom(raw: string): string {
  return raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
}

/**
 * Paths named by ApplyPatch mutation headers, plus `*** Move to:` rename
 * destinations. Order preserved, duplicates dropped.
 */
export function applyPatchMutationPaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    const path = raw?.trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const match of text.matchAll(APPLY_PATCH_MUTATION_LINE_RE)) push(match[2]);
  for (const match of text.matchAll(APPLY_PATCH_MOVE_DESTINATION_RE)) push(match[1]);
  return paths;
}

/** Canonical apply_patch envelope: Begin marker, then End marker (#5129). */
export function applyPatchHasCanonicalEnvelope(text: string): boolean {
  const begin = text.indexOf(APPLY_PATCH_BEGIN_MARKER);
  if (begin < 0) return false;
  const end = text.indexOf(APPLY_PATCH_END_MARKER, begin + APPLY_PATCH_BEGIN_MARKER.length);
  return end >= 0;
}

function trySynthesizeFreeFormApplyPatch(normalized: string): ParsedHookPayload | null {
  if (!applyPatchHasCanonicalEnvelope(normalized)) return null;
  const mutations: { op: string; path: string }[] = [];
  for (const match of normalized.matchAll(APPLY_PATCH_MUTATION_LINE_RE)) {
    const op = match[1];
    const path = match[2]?.trim();
    if (op === undefined || !path) continue;
    mutations.push({ op, path });
  }
  if (mutations.length !== 1) return null;
  // Count headers plus Move-to destinations so a rename cannot collapse to one
  // checked path (#3614 / #3794). Reuses applyPatchMutationPaths; no second parser.
  if (applyPatchMutationPaths(normalized).length !== 1) return null;
  const sole = mutations[0];
  if (sole === undefined || (sole.op !== "Add File" && sole.op !== "Update File")) return null;
  return {
    payload: {
      tool_name: "ApplyPatch",
      tool_input: {
        path: sole.path,
        patch: normalized,
      },
    },
    context: {},
  };
}

function declaredWritePathFromParsed(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  return firstString([
    toolInput?.file_path,
    toolInput?.filePath,
    toolInput?.path,
    input.file_path,
    input.filePath,
    input.path,
  ]);
}

const APPLY_PATCH_BODY_KEYS = ["patch", "unified_diff", "diff"] as const;

/**
 * Declared ApplyPatch tool name — not inferred from command text.
 * Same normalizer as dispatcher `isApplyPatchTool` so `apply-patch` admits
 * command-body harvest (#5094 Greptile).
 */
function payloadDeclaresApplyPatchTool(payload: Record<string, unknown>): boolean {
  const toolObject = record(payload.tool);
  const toolCall = record(payload.tool_call) ?? record(payload.toolCall);
  const name =
    fieldString(payload, "tool_name") ??
    fieldString(payload, "toolName") ??
    fieldString(payload, "tool") ??
    (toolObject !== null ? fieldString(toolObject, "name") : null) ??
    (toolCall !== null ? fieldString(toolCall, "name") : null);
  return name !== null && isApplyPatchTool(name);
}

function pushUniqueBodyText(into: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (text.length === 0 || into.includes(text)) return;
  into.push(text);
}

/**
 * Declared-ApplyPatch freeform `input` strings: nested `tool_input.input` and
 * top-level string `payload.input`. Not raw-string `tool_input` (#5129).
 */
function harvestedDeclaredApplyPatchInputTexts(payload: unknown): string[] {
  const input = record(payload);
  if (input === null || !payloadDeclaresApplyPatchTool(input)) return [];
  const toolInput = toolInputRecord(input);
  const texts: string[] = [];
  if (toolInput !== null) pushUniqueBodyText(texts, toolInput.input);
  pushUniqueBodyText(texts, input.input);
  return texts;
}

/**
 * True when a declared ApplyPatch harvested an `input` shape that is not a
 * canonical envelope with at least one mutation target (#5129). Scoped to those
 * shapes so declared-path-only and patch/unified_diff/diff stay as landed.
 */
export function applyPatchHarvestedInputUnclassified(payload: unknown): boolean {
  const texts = harvestedDeclaredApplyPatchInputTexts(payload);
  if (texts.length === 0) return false;
  for (const text of texts) {
    if (!applyPatchHasCanonicalEnvelope(text)) return true;
    if (applyPatchMutationPaths(text).length === 0) return true;
  }
  return false;
}

/**
 * ApplyPatch body field texts. `command` is admitted only when the payload
 * declares an ApplyPatch tool (`isApplyPatchTool`) — never via host-agnostic
 * firstString, and never for Shell/Bash command strings (#5094). String
 * `tool_input.input` / top-level `input` join the same declared-tool branch
 * when they carry a canonical Begin/End envelope (#5129).
 */
export function applyPatchBodyFieldTexts(payload: unknown): string[] {
  const input = record(payload);
  if (input === null) return [];
  const toolInput = toolInputRecord(input);
  const texts: string[] = [];
  for (const key of APPLY_PATCH_BODY_KEYS) {
    if (toolInput !== null) pushUniqueBodyText(texts, toolInput[key]);
    pushUniqueBodyText(texts, input[key]);
  }
  if (payloadDeclaresApplyPatchTool(input)) {
    if (toolInput !== null) pushUniqueBodyText(texts, toolInput.command);
    pushUniqueBodyText(texts, input.command);
    for (const text of harvestedDeclaredApplyPatchInputTexts(input)) {
      if (applyPatchHasCanonicalEnvelope(text)) pushUniqueBodyText(texts, text);
    }
  }
  return texts;
}

/** Union of present ApplyPatch body fields as one parseable blob. */
export function applyPatchBodyTextFromParsed(payload: unknown): string | null {
  const texts = applyPatchBodyFieldTexts(payload);
  if (texts.length === 0) return null;
  return texts.join("\n");
}

function withToolInputPath(parsed: unknown, path: string): unknown {
  const input = record(parsed);
  if (input === null) return parsed;
  for (const key of ["tool_input", "toolInput", "input", "arguments"] as const) {
    const nested = record(input[key]);
    if (nested !== null) {
      return { ...input, [key]: { ...nested, path } };
    }
  }
  return { ...input, tool_input: { path } };
}

/**
 * Valid-JSON hosts (Codex) never hit the JSON.parse catch arm, so the free-form
 * extractor was unreached. Call it on the patch body when no path was declared.
 * Does not replace the parsed payload; only fills tool_input.path.
 */
function attachSynthesizedApplyPatchPath(parsed: unknown): unknown {
  if (declaredWritePathFromParsed(parsed) !== null) return parsed;
  const patch = applyPatchBodyTextFromParsed(parsed);
  if (patch === null) return parsed;
  const synthesized = trySynthesizeFreeFormApplyPatch(patch);
  if (synthesized === null) return parsed;
  const synthesizedPath = declaredWritePathFromParsed(synthesized.payload);
  if (synthesizedPath === null) return parsed;
  return withToolInputPath(parsed, synthesizedPath);
}

/**
 * Parse host hook stdin text into a payload + parse context.
 * Empty → stdinEmpty; invalid JSON without free-form ApplyPatch → parseFailed.
 */
export function parseHookStdin(raw: string): ParsedHookPayload {
  if (raw.trim().length === 0) {
    return { payload: {}, context: { stdinEmpty: true } };
  }
  const normalized = stripUtf8Bom(raw);
  if (normalized.trim().length === 0) {
    return { payload: {}, context: { stdinEmpty: true } };
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return {
      payload: landProcessOnlyFlagOnToolInput(attachSynthesizedApplyPatchPath(parsed)),
      context: {},
    };
  } catch {
    const synthesized = trySynthesizeFreeFormApplyPatch(normalized);
    if (synthesized !== null) return synthesized;
    // tool.before is installed only on direct-write matchers, so an unreadable
    // payload becomes a missing-tool denial rather than a fail-open crash.
    return { payload: {}, context: { parseFailed: true } };
  }
}
