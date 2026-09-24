/**
 * Conversation/workspace identity for Cursor planning choice (#4973).
 * Hash is a length-delimited tuple (host, real workspace root, conversation_id).
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fieldString, record, resolveHookHostIdentity } from "../classify/index.js";
import {
  CURSOR_PLAN_CHOICE_HOST,
  type CursorPlanChoiceIdentity,
  KNOWN_NON_PLAN_COMPOSER_MODES,
  PLAN_COMPOSER_MODE,
  SUPPORTED_CURSOR_PLAN_CHOICE_VERSION,
} from "./types.js";

export type IdentityFailureCode =
  | "malformed"
  | "unsupported-surface"
  | "unknown-mode"
  | "identity-invalid";

export type IdentityFailure = {
  readonly ok: false;
  readonly code: IdentityFailureCode;
  readonly message: string;
};

export type ComposerModeClass = "plan" | "known-non-plan";

export type IdentityOk = {
  readonly ok: true;
  readonly identity: CursorPlanChoiceIdentity;
  readonly modeClass: ComposerModeClass;
  readonly cursorVersion: string;
  readonly generationId: string | null;
  readonly prompt: string;
  readonly attachments: readonly unknown[];
};

export type IdentityResult = IdentityOk | IdentityFailure;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function lengthDelimited(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");
}

export function hashPlanChoiceTuple(parts: readonly string[]): string {
  return sha256Hex(lengthDelimited(parts));
}

export function canonicalWorkspaceRoot(path: string): string {
  const normalized = resolve(path);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function uniqueWorkspaceRoots(payload: Record<string, unknown>): string[] | null {
  if (!("workspace_roots" in payload)) return null;
  const raw = payload.workspace_roots;
  if (!Array.isArray(raw)) return null;
  const unique = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) return null;
    unique.add(canonicalWorkspaceRoot(entry.trim()));
  }
  return [...unique];
}

export function classifyComposerMode(value: unknown): ComposerModeClass | "missing" | "unknown" {
  if (typeof value !== "string" || value.trim().length === 0) return "missing";
  const mode = value.trim();
  if (mode === PLAN_COMPOSER_MODE) return "plan";
  if ((KNOWN_NON_PLAN_COMPOSER_MODES as readonly string[]).includes(mode)) return "known-non-plan";
  return "unknown";
}

function emptyIdentity(): CursorPlanChoiceIdentity {
  return {
    conversationId: "",
    workspaceRoot: "",
    workspaceHash: "",
    conversationHash: "",
    recordKey: "",
  };
}

export type AckIdentityResult =
  | {
      readonly ok: true;
      readonly identity: CursorPlanChoiceIdentity;
      readonly generationId: string | null;
    }
  | IdentityFailure;

/**
 * afterAgentResponse identity: conversation + unique workspace root.
 * Missing/unknown composer_mode does not invent a Plan submission.
 */
export function resolveAckIdentity(payload: unknown, invocationRoot: string): AckIdentityResult {
  const input = record(payload);
  if (input === null) {
    return {
      ok: false,
      code: "malformed",
      message:
        "afterAgentResponse payload was not an object; planning-choice state was not advanced.",
    };
  }
  const hostIdentity = resolveHookHostIdentity("cursor", input);
  if (hostIdentity.status !== "ok") {
    return {
      ok: false,
      code: "identity-invalid",
      message: "afterAgentResponse conversation identity was missing or mismatched.",
    };
  }
  const roots = uniqueWorkspaceRoots(input);
  const invocation = canonicalWorkspaceRoot(invocationRoot);
  if (roots === null || roots.length !== 1 || roots[0] !== invocation) {
    return {
      ok: false,
      code: "identity-invalid",
      message: "afterAgentResponse workspace root was missing, ambiguous, or mismatched.",
    };
  }
  const conversationId = hostIdentity.rawSessionId;
  const workspaceRoot = roots[0];
  return {
    ok: true,
    identity: {
      conversationId,
      workspaceRoot,
      workspaceHash: hashPlanChoiceTuple([CURSOR_PLAN_CHOICE_HOST, workspaceRoot]),
      conversationHash: hashPlanChoiceTuple([conversationId]),
      recordKey: hashPlanChoiceTuple([CURSOR_PLAN_CHOICE_HOST, workspaceRoot, conversationId]),
    },
    generationId: fieldString(input, "generation_id"),
  };
}

export function resolvePlanChoiceIdentity(
  payload: unknown,
  invocationRoot: string,
): IdentityResult {
  const input = record(payload);
  if (input === null) {
    return {
      ok: false,
      code: "malformed",
      message:
        "Directive blocked this Plan request: the hook payload was malformed. No planning choice was recorded.",
    };
  }
  const modeClass = classifyComposerMode(input.composer_mode);
  if (modeClass === "known-non-plan") {
    return {
      ok: true,
      identity: emptyIdentity(),
      modeClass,
      cursorVersion: fieldString(input, "cursor_version") ?? "",
      generationId: fieldString(input, "generation_id"),
      prompt: typeof input.prompt === "string" ? input.prompt : "",
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
    };
  }
  const cursorVersion = fieldString(input, "cursor_version");
  if (cursorVersion !== SUPPORTED_CURSOR_PLAN_CHOICE_VERSION) {
    return {
      ok: false,
      code: "unsupported-surface",
      message:
        "Directive cannot record a planning choice on this Cursor surface. Supported: local Cursor IDE 3.21.16 (observed contract). This host version or payload is unverified. The Plan request is blocked. Agent/Ask is unaffected when the mode is known.",
    };
  }
  if (modeClass === "missing" || modeClass === "unknown") {
    return {
      ok: false,
      code: "unknown-mode",
      message:
        'Directive blocked this request: composer_mode is missing or unknown. Known Agent/Ask modes proceed without a planning choice. Plan requires composer_mode "plan".',
    };
  }
  if (!Array.isArray(input.attachments)) {
    return {
      ok: false,
      code: "malformed",
      message:
        "Directive blocked this Plan request: attachments must be a JSON array. Attachment contents are never read as an answer.",
    };
  }
  const hostIdentity = resolveHookHostIdentity("cursor", input);
  if (hostIdentity.status !== "ok") {
    return {
      ok: false,
      code: "identity-invalid",
      message:
        "Directive blocked this Plan request: conversation identity or workspace root is missing, ambiguous, or mismatched. No planning choice was recorded.",
    };
  }
  const roots = uniqueWorkspaceRoots(input);
  const invocation = canonicalWorkspaceRoot(invocationRoot);
  if (roots === null || roots.length !== 1 || roots[0] !== invocation) {
    return {
      ok: false,
      code: "identity-invalid",
      message:
        "Directive blocked this Plan request: conversation identity or workspace root is missing, ambiguous, or mismatched. No planning choice was recorded.",
    };
  }
  const conversationId = hostIdentity.rawSessionId;
  const workspaceRoot = roots[0];
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  return {
    ok: true,
    identity: {
      conversationId,
      workspaceRoot,
      workspaceHash: hashPlanChoiceTuple([CURSOR_PLAN_CHOICE_HOST, workspaceRoot]),
      conversationHash: hashPlanChoiceTuple([conversationId]),
      recordKey: hashPlanChoiceTuple([CURSOR_PLAN_CHOICE_HOST, workspaceRoot, conversationId]),
    },
    modeClass: "plan",
    cursorVersion,
    generationId: fieldString(input, "generation_id"),
    prompt,
    attachments: input.attachments,
  };
}
