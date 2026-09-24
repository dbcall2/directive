import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorPlanChoiceStoreRoot } from "./cursor-plan-choice/index.js";
import {
  decideHook,
  type HookDecision,
  type HookPolicySeams,
  renderHostDecision,
} from "./dispatcher.js";

const READY_RITUAL = {
  code: 0,
  message: "OK",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

function readySeams(): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => ({
      ready: true,
      path: "/project/xbrief/active/story.xbrief.json",
      message: "OK",
    }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
  };
}

describe("Cursor planning-choice dispatcher wiring (#4973)", () => {
  it("renders continue false for a Plan-choice block", () => {
    const decision: HookDecision = {
      verdict: "deny",
      code: "plan-choice-question",
      event: "prompt.submit",
      host: "cursor",
      toolName: null,
      projectRoot: "/project",
      message: "choose",
      scopePath: null,
    };
    expect(JSON.parse(renderHostDecision("cursor", decision))).toEqual({
      continue: false,
      user_message: "choose",
      code: "plan-choice-question",
    });
    expect(
      JSON.parse(
        renderHostDecision("cursor", {
          ...decision,
          verdict: "allow",
          code: "plan-choice-allow-non-plan",
        }),
      ),
    ).toEqual({ continue: true, code: "plan-choice-allow-non-plan" });
  });

  it("denies recognized writes to the planning-choice store with an active scope", () => {
    const store = cursorPlanChoiceStoreRoot(process.env, process.platform, homedir());
    const target = join(store, "deadbeef", "cafebabe.json");
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Write", tool_input: { path: target } },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("plan-choice-store-deny");
    expect(decision.message).toContain("planning-choice store");
  });
});
