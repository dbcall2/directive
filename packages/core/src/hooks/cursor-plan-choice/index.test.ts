import { describe, expect, it } from "vitest";
import { decideCursorPlanChoice, parsePlanChoiceAnswer } from "./index.js";

describe("cursor-plan-choice public barrel", () => {
  it("re-exports a working adapter and parser", () => {
    const token = "cd".repeat(16);
    expect(parsePlanChoiceAnswer(`DEFT-PLAN-CHOICE ${token} 2`)).toEqual({
      token,
      choice: 2,
      canonical: `DEFT-PLAN-CHOICE ${token} 2`,
    });
    const decision = decideCursorPlanChoice({
      host: "cursor",
      event: "prompt.submit",
      projectRoot: "/tmp",
      payload: { composer_mode: "ask", prompt: "what is the plan" },
    });
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("plan-choice-allow-non-plan");
  });
});
