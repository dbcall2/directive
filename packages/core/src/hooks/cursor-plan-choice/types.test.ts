import { describe, expect, it } from "vitest";
import {
  CURSOR_PLAN_CHOICE_HOST,
  CURSOR_PLAN_CHOICE_LIMITS,
  CURSOR_PLAN_CHOICE_QUESTION_VERSION,
  CURSOR_PLAN_CHOICE_SCHEMA,
  KNOWN_NON_PLAN_COMPOSER_MODES,
  PLAN_CHOICE_ANSWER_PREFIX,
  PLAN_COMPOSER_MODE,
  SUPPORTED_CURSOR_PLAN_CHOICE_VERSION,
} from "./types.js";

describe("cursor plan-choice bound constants", () => {
  it("keeps the operator-named retention and token sizes", () => {
    expect(CURSOR_PLAN_CHOICE_LIMITS.tokenBytes).toBe(16);
    expect(CURSOR_PLAN_CHOICE_LIMITS.pendingTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(CURSOR_PLAN_CHOICE_LIMITS.selectedIdleMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(CURSOR_PLAN_CHOICE_LIMITS.dirMode).toBe(0o700);
    expect(CURSOR_PLAN_CHOICE_LIMITS.fileMode).toBe(0o600);
  });

  it("pins the Cursor-only schema and observed Plan mode", () => {
    expect(CURSOR_PLAN_CHOICE_HOST).toBe("cursor");
    expect(PLAN_COMPOSER_MODE).toBe("plan");
    expect(SUPPORTED_CURSOR_PLAN_CHOICE_VERSION).toBe("3.21.16");
    expect(PLAN_CHOICE_ANSWER_PREFIX).toBe("DEFT-PLAN-CHOICE");
    expect(CURSOR_PLAN_CHOICE_SCHEMA).toBe("deft.cursor-plan-choice.v1");
    expect(CURSOR_PLAN_CHOICE_QUESTION_VERSION).toBe("cursor-plan-choice.q1");
    expect([...KNOWN_NON_PLAN_COMPOSER_MODES]).toEqual(["agent", "ask", "edit", "chat"]);
  });
});
