import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HookDispatchInput } from "../dispatcher.js";
import { decideCursorPlanChoice } from "./adapter.js";
import type { CursorPlanChoiceDeps } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, "fixtures", "v1", name), "utf8")) as Record<
    string,
    unknown
  >;
}

function deps(): CursorPlanChoiceDeps {
  const configDir = mkdtempSync(join(tmpdir(), "plan-choice-fix-"));
  temps.push(configDir);
  return {
    now: () => 9_000_000,
    randomBytes: (size) => Buffer.alloc(size, 3),
    configDir,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
    processExists: () => true,
    sleepMs: () => undefined,
    homedir: configDir,
    env: {},
  };
}

describe("versioned redacted Cursor 3.21.16 fixtures", () => {
  it("blocks a first Plan submit and allows the Agent control", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-choice-fix-ws-")));
    temps.push(root);
    mkdirSync(root, { recursive: true });
    const plan = loadFixture("plan-first-submit.json");
    plan.workspace_roots = [root];
    const agent = loadFixture("agent-control.json");
    agent.workspace_roots = [root];
    const d = deps();
    const planDecision = decideCursorPlanChoice(
      {
        host: "cursor",
        event: "prompt.submit",
        projectRoot: root,
        payload: plan,
      } satisfies HookDispatchInput,
      d,
    );
    expect(planDecision.verdict).toBe("deny");
    expect(planDecision.code).toBe("plan-choice-question");
    const agentDecision = decideCursorPlanChoice(
      { host: "cursor", event: "prompt.submit", projectRoot: root, payload: agent },
      d,
    );
    expect(agentDecision.verdict).toBe("allow");
    expect(agentDecision.code).toBe("plan-choice-allow-non-plan");
  });

  it("acks a matching afterAgentResponse fixture generation after Directive handoff", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-choice-fix-ws-")));
    temps.push(root);
    mkdirSync(root, { recursive: true });
    const plan = loadFixture("plan-first-submit.json");
    plan.workspace_roots = [root];
    const d = deps();
    const question = decideCursorPlanChoice(
      { host: "cursor", event: "prompt.submit", projectRoot: root, payload: plan },
      d,
    );
    const token = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(question.message)?.[1];
    expect(token).toHaveLength(32);
    decideCursorPlanChoice(
      {
        host: "cursor",
        event: "prompt.submit",
        projectRoot: root,
        payload: { ...plan, prompt: `DEFT-PLAN-CHOICE ${token} 1` },
      },
      d,
    );
    const ackFixture = loadFixture("after-agent-response.json");
    const generationId = ackFixture.generation_id;
    expect(typeof generationId).toBe("string");
    expect(Array.isArray(ackFixture.workspace_roots)).toBe(true);
    const handoff = decideCursorPlanChoice(
      {
        host: "cursor",
        event: "prompt.submit",
        projectRoot: root,
        payload: {
          ...plan,
          prompt: "/deft:directive:run:interview design the planning join",
          generation_id: generationId,
        },
      },
      d,
    );
    expect(handoff.code).toBe("plan-choice-allow-interview");
    ackFixture.workspace_roots = [root];
    const ack = decideCursorPlanChoice(
      {
        host: "cursor",
        event: "agent.response",
        projectRoot: root,
        payload: ackFixture,
      },
      d,
    );
    expect(ack.verdict).toBe("allow");
    expect(ack.code).toBe("plan-choice-ack-observed");
  });
});
