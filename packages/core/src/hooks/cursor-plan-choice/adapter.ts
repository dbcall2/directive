/**
 * Cursor beforeSubmitPrompt / afterAgentResponse planning-choice adapter (#4973).
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { detectNoDeftDirective } from "../../policy/no-deft-directive.js";
import { platformUserConfigDir } from "../../user-config/resolve-user-md.js";
import type { HookDecision, HookDispatchInput } from "../dispatcher.js";
import { resolveAckIdentity, resolvePlanChoiceIdentity } from "./identity.js";
import {
  backMessage,
  directiveSelectionReceiptMessage,
  discussMessage,
  handoffRequiredMessage,
  hostOnlySelectionReceiptMessage,
  lockAmbiguousMessage,
  lockBusyMessage,
  planningChoiceQuestionMessage,
  storageFailureMessage,
} from "./messages.js";
import { parseInterviewHandoffPrompt, parsePlanChoiceAnswer } from "./parser.js";
import {
  emptyPendingRecord,
  isPendingLive,
  isSelectedLive,
  newPending,
  withPlanChoiceRecord,
} from "./store.js";
import type { CursorPlanChoiceDeps, CursorPlanChoiceRecord, PlanChoiceSelected } from "./types.js";
import { CURSOR_PLAN_CHOICE_QUESTION_VERSION } from "./types.js";

export type CursorPlanChoiceDecisionCode =
  | "plan-choice-allow-non-plan"
  | "plan-choice-question"
  | "plan-choice-selected-receipt"
  | "plan-choice-idempotent-receipt"
  | "plan-choice-discuss"
  | "plan-choice-back"
  | "plan-choice-handoff-required"
  | "plan-choice-allow-host-only"
  | "plan-choice-allow-interview"
  | "plan-choice-allow-followup"
  | "plan-choice-unsupported-surface"
  | "plan-choice-identity-invalid"
  | "plan-choice-malformed"
  | "plan-choice-unknown-mode"
  | "plan-choice-storage-failure"
  | "plan-choice-lock-busy"
  | "plan-choice-lock-ambiguous"
  | "plan-choice-ack-observed"
  | "plan-choice-ack-ignored"
  | "plan-choice-opt-out";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

export function defaultCursorPlanChoiceDeps(
  environ: NodeJS.ProcessEnv = process.env,
): CursorPlanChoiceDeps {
  const platform = process.platform;
  const home = homedir();
  return {
    now: () => Date.now(),
    randomBytes,
    configDir: platformUserConfigDir(platform, environ, home),
    platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
    processExists,
    sleepMs: defaultSleep,
    homedir: home,
    env: environ,
  };
}

function decision(
  input: HookDispatchInput,
  verdict: "allow" | "deny",
  code: CursorPlanChoiceDecisionCode,
  message: string,
): HookDecision {
  return {
    verdict,
    code: code as HookDecision["code"],
    event: input.event,
    host: input.host,
    toolName: null,
    projectRoot: input.projectRoot,
    message,
    scopePath: null,
  };
}

function storeErrorDecision(input: HookDispatchInput, code: string): HookDecision {
  if (code === "lock-busy") {
    return decision(input, "deny", "plan-choice-lock-busy", lockBusyMessage());
  }
  if (code === "lock-ambiguous") {
    return decision(input, "deny", "plan-choice-lock-ambiguous", lockAmbiguousMessage());
  }
  return decision(input, "deny", "plan-choice-storage-failure", storageFailureMessage());
}

function selectedFromPending(
  record: CursorPlanChoiceRecord,
  choice: 1 | 2,
  canonical: string,
  token: string,
  hostBuild: string,
  generationId: string | null,
  nowIso: string,
): PlanChoiceSelected {
  return {
    choice,
    selectedAt: nowIso,
    lastUsedAt: nowIso,
    canonicalAnswer: canonical,
    questionVersion: CURSOR_PLAN_CHOICE_QUESTION_VERSION,
    nonce: token,
    hostBuild,
    answerGenerationId: generationId,
    workspaceHash: record.workspaceHash,
    conversationHash: record.conversationHash,
    handoff: { status: "none", generationId: null },
  };
}

export function decideCursorPlanChoice(
  input: HookDispatchInput,
  deps: CursorPlanChoiceDeps = defaultCursorPlanChoiceDeps(input.environ ?? process.env),
): HookDecision {
  if (input.host !== "cursor") {
    return decision(
      input,
      "deny",
      "plan-choice-unsupported-surface",
      "Directive cannot record a planning choice on this host. Cursor-only first ship.",
    );
  }
  const optOut = detectNoDeftDirective(input.projectRoot);
  if (optOut.present) {
    return decision(
      input,
      "allow",
      "plan-choice-opt-out",
      "Directive planning-choice adapter skipped because .no-deft-directive is present.",
    );
  }
  if (input.event === "agent.response") {
    return decideAgentResponse(input, deps);
  }
  return decidePromptSubmit(input, deps);
}

function decidePromptSubmit(input: HookDispatchInput, deps: CursorPlanChoiceDeps): HookDecision {
  const classified = resolvePlanChoiceIdentity(input.payload, input.projectRoot);
  if (!classified.ok) {
    const code =
      classified.code === "malformed"
        ? "plan-choice-malformed"
        : classified.code === "unknown-mode"
          ? "plan-choice-unknown-mode"
          : classified.code === "identity-invalid"
            ? "plan-choice-identity-invalid"
            : "plan-choice-unsupported-surface";
    return decision(input, "deny", code, classified.message);
  }
  if (classified.modeClass === "known-non-plan") {
    return decision(
      input,
      "allow",
      "plan-choice-allow-non-plan",
      "Known non-Plan composer mode; planning-choice state was not created or consumed.",
    );
  }
  const identity = classified.identity;
  const prompt = classified.prompt;
  const parsedAnswer = parsePlanChoiceAnswer(prompt);
  const nowIso = new Date(deps.now()).toISOString();
  const updated = withPlanChoiceRecord(deps, identity, (current) => {
    const liveSelected =
      current !== null && isSelectedLive(current.selected, deps.now()) ? current.selected : null;
    if (liveSelected !== null) {
      if (current === null) return { ok: true, value: current };
      if (parsedAnswer !== null && parsedAnswer.canonical === liveSelected.canonicalAnswer) {
        return {
          ok: true,
          value: {
            ...current,
            status: "selected",
            pending: null,
            selected: liveSelected,
          },
        };
      }
      if (liveSelected.choice === 2) {
        return {
          ok: true,
          value: {
            ...current,
            status: "selected",
            pending: null,
            selected: { ...liveSelected, lastUsedAt: nowIso },
          },
        };
      }
      if (liveSelected.handoff.status === "response-observed") {
        return {
          ok: true,
          value: {
            ...current,
            status: "selected",
            pending: null,
            selected: { ...liveSelected, lastUsedAt: nowIso },
          },
        };
      }
      const handoff = parseInterviewHandoffPrompt(prompt);
      if (handoff.ok) {
        return {
          ok: true,
          value: {
            ...current,
            status: "selected",
            pending: null,
            selected: {
              ...liveSelected,
              lastUsedAt: nowIso,
              handoff: { status: "pending", generationId: classified.generationId },
            },
          },
        };
      }
      return { ok: true, value: current };
    }
    const livePending =
      current !== null && isPendingLive(current.pending, deps.now()) ? current.pending : null;
    if (livePending !== null && parsedAnswer !== null && parsedAnswer.token === livePending.token) {
      if (parsedAnswer.choice === 3) {
        return { ok: true, value: null };
      }
      if (parsedAnswer.choice === 4) {
        return { ok: true, value: null };
      }
      if (parsedAnswer.choice === 1 || parsedAnswer.choice === 2) {
        const selected = selectedFromPending(
          current ?? emptyPendingRecord(identity, livePending),
          parsedAnswer.choice,
          parsedAnswer.canonical,
          livePending.token,
          classified.cursorVersion,
          classified.generationId,
          nowIso,
        );
        return {
          ok: true,
          value: {
            ...(current ?? emptyPendingRecord(identity, livePending)),
            status: "selected",
            pending: null,
            selected,
          },
        };
      }
    }
    if (livePending !== null) {
      return {
        ok: true,
        value: current ?? emptyPendingRecord(identity, livePending),
      };
    }
    const pending = newPending(deps);
    return { ok: true, value: emptyPendingRecord(identity, pending) };
  });
  if (!updated.ok) return storeErrorDecision(input, updated.code);
  const recordState = updated.value;
  if (recordState === null) {
    if (parsedAnswer?.choice === 3) {
      return decision(input, "deny", "plan-choice-discuss", discussMessage());
    }
    return decision(input, "deny", "plan-choice-back", backMessage());
  }
  if (recordState.status === "selected" && recordState.selected !== null) {
    const selected = recordState.selected;
    if (parsedAnswer !== null && parsedAnswer.canonical === selected.canonicalAnswer) {
      const receipt =
        selected.choice === 1
          ? directiveSelectionReceiptMessage()
          : hostOnlySelectionReceiptMessage();
      return decision(input, "deny", "plan-choice-idempotent-receipt", receipt);
    }
    if (
      parsedAnswer !== null &&
      parsedAnswer.token === selected.nonce &&
      parsedAnswer.canonical !== selected.canonicalAnswer
    ) {
      const receipt =
        selected.choice === 1
          ? directiveSelectionReceiptMessage()
          : hostOnlySelectionReceiptMessage();
      return decision(input, "deny", "plan-choice-idempotent-receipt", receipt);
    }
    if (selected.choice === 2) {
      return decision(
        input,
        "allow",
        "plan-choice-allow-host-only",
        "Host-only planning is recorded for this conversation. Product-write gates still apply.",
      );
    }
    if (selected.handoff.status === "response-observed") {
      return decision(
        input,
        "allow",
        "plan-choice-allow-followup",
        "Directive planning interview may continue. A response acknowledgement is not strategy completion.",
      );
    }
    if (selected.handoff.status === "pending" && parseInterviewHandoffPrompt(prompt).ok) {
      return decision(
        input,
        "allow",
        "plan-choice-allow-interview",
        "Directive recorded an interview handoff attempt. A matching afterAgentResponse records transport progress only.",
      );
    }
    if (parseInterviewHandoffPrompt(prompt).ok === false && selected.choice === 1) {
      return decision(input, "deny", "plan-choice-handoff-required", handoffRequiredMessage());
    }
    return decision(
      input,
      "deny",
      "plan-choice-selected-receipt",
      selected.choice === 1
        ? directiveSelectionReceiptMessage()
        : hostOnlySelectionReceiptMessage(),
    );
  }
  const token = recordState.pending?.token;
  if (token === undefined) {
    return decision(input, "deny", "plan-choice-storage-failure", storageFailureMessage());
  }
  return decision(input, "deny", "plan-choice-question", planningChoiceQuestionMessage(token));
}

function decideAgentResponse(input: HookDispatchInput, deps: CursorPlanChoiceDeps): HookDecision {
  const classified = resolveAckIdentity(input.payload, input.projectRoot);
  if (!classified.ok) {
    return decision(input, "allow", "plan-choice-ack-ignored", classified.message);
  }
  const generationId = classified.generationId;
  const updated = withPlanChoiceRecord(deps, classified.identity, (current) => {
    if (current === null || current.selected === null) return { ok: true, value: current };
    if (!isSelectedLive(current.selected, deps.now())) return { ok: true, value: current };
    if (current.selected.handoff.status === "response-observed") {
      if (current.selected.handoff.generationId === generationId) {
        return { ok: true, value: current };
      }
      return { ok: true, value: current };
    }
    if (current.selected.handoff.status !== "pending") return { ok: true, value: current };
    if (generationId === null || current.selected.handoff.generationId !== generationId) {
      return { ok: true, value: current };
    }
    return {
      ok: true,
      value: {
        ...current,
        selected: {
          ...current.selected,
          lastUsedAt: new Date(deps.now()).toISOString(),
          handoff: { status: "response-observed", generationId },
        },
      },
    };
  });
  if (!updated.ok) {
    return decision(input, "allow", "plan-choice-ack-ignored", storageFailureMessage());
  }
  const selected = updated.value?.selected;
  if (
    selected?.handoff.status === "response-observed" &&
    selected.handoff.generationId === generationId
  ) {
    return decision(
      input,
      "allow",
      "plan-choice-ack-observed",
      "Matching afterAgentResponse recorded transport progress only. It is not strategy completion or implementation approval.",
    );
  }
  return decision(
    input,
    "allow",
    "plan-choice-ack-ignored",
    "afterAgentResponse did not match a pending handoff generation.",
  );
}
