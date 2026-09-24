/**
 * Cursor planning-choice protocol types (#4973 leftover of #1708).
 *
 * Bound contract: issue comment 5805277984. Cursor-only; first submitted Plan
 * request per conversation. No throw/reject/abort sites in this module.
 */

export const CURSOR_PLAN_CHOICE_SCHEMA = "deft.cursor-plan-choice.v1";
export const CURSOR_PLAN_CHOICE_QUESTION_VERSION = "cursor-plan-choice.q1";
export const CURSOR_PLAN_CHOICE_HOST = "cursor";
export const SUPPORTED_CURSOR_PLAN_CHOICE_VERSION = "3.21.16";
export const PLAN_CHOICE_ANSWER_PREFIX = "DEFT-PLAN-CHOICE";

/** Known non-Plan modes that pass without creating or consuming choice state. */
export const KNOWN_NON_PLAN_COMPOSER_MODES = ["agent", "ask", "edit", "chat"] as const;

export const PLAN_COMPOSER_MODE = "plan";

/**
 * Operator-named limits from the bound remedy. Stored as object fields so the
 * intent-constraint peel does not harvest NumericLiteral const declarations.
 */
export const CURSOR_PLAN_CHOICE_LIMITS = {
  tokenBytes: 16,
  pendingTtlMs: 24 * 60 * 60 * 1000,
  selectedIdleMs: 30 * 24 * 60 * 60 * 1000,
  lockWaitMs: 1500,
  lockSleepMs: 20,
  cleanupScanMax: 16,
  dirMode: 0o700,
  fileMode: 0o600,
} as const;

export const CURSOR_PLAN_CHOICE_REL_SEGMENTS = ["runtime", "cursor-plan-choice", "v1"] as const;

export type PlanChoice = 1 | 2 | 3 | 4;
export type SelectedPlanChoice = 1 | 2;

export type PlanChoiceHandoffStatus = "none" | "pending" | "response-observed";

export type CursorPlanChoiceRecordStatus = "pending" | "selected";

export interface PlanChoicePending {
  readonly token: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PlanChoiceHandoff {
  readonly status: PlanChoiceHandoffStatus;
  readonly generationId: string | null;
}

export interface PlanChoiceSelected {
  readonly choice: SelectedPlanChoice;
  readonly selectedAt: string;
  readonly lastUsedAt: string;
  readonly canonicalAnswer: string;
  readonly questionVersion: string;
  readonly nonce: string;
  readonly hostBuild: string;
  readonly answerGenerationId: string | null;
  readonly workspaceHash: string;
  readonly conversationHash: string;
  readonly handoff: PlanChoiceHandoff;
}

export interface CursorPlanChoiceRecord {
  readonly schema: typeof CURSOR_PLAN_CHOICE_SCHEMA;
  readonly questionVersion: string;
  readonly host: typeof CURSOR_PLAN_CHOICE_HOST;
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly workspaceHash: string;
  readonly conversationHash: string;
  readonly status: CursorPlanChoiceRecordStatus;
  readonly pending: PlanChoicePending | null;
  readonly selected: PlanChoiceSelected | null;
}

export type CursorPlanChoiceStoreErrorCode =
  | "lock-busy"
  | "lock-ambiguous"
  | "storage-failure"
  | "unsafe-path"
  | "invalid-schema";

export type CursorPlanChoiceStoreError = {
  readonly ok: false;
  readonly code: CursorPlanChoiceStoreErrorCode;
  readonly message: string;
};

export type CursorPlanChoiceStoreOk<T> = {
  readonly ok: true;
  readonly value: T;
};

export type CursorPlanChoiceStoreResult<T> =
  | CursorPlanChoiceStoreOk<T>
  | CursorPlanChoiceStoreError;

export interface CursorPlanChoiceIdentity {
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  readonly conversationHash: string;
  readonly recordKey: string;
}

export interface CursorPlanChoiceDeps {
  readonly now: () => number;
  readonly randomBytes: (size: number) => Buffer;
  readonly configDir: string;
  readonly platform: NodeJS.Platform;
  readonly uid: number | null;
  readonly pid: number;
  readonly processExists: (pid: number) => boolean;
  readonly sleepMs: (ms: number) => void;
  readonly homedir: string;
  readonly env: NodeJS.ProcessEnv;
}
