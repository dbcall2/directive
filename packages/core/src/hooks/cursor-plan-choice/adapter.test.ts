import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookDispatchInput } from "../dispatcher.js";
import { decideCursorPlanChoice } from "./adapter.js";
import { parsePlanChoiceAnswer } from "./parser.js";
import type { CursorPlanChoiceDeps } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-choice-ws-"));
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function deps(nowMs: { value: number }): CursorPlanChoiceDeps {
  const configDir = mkdtempSync(join(tmpdir(), "plan-choice-cfg-"));
  temps.push(configDir);
  let seq = 0;
  return {
    now: () => nowMs.value,
    randomBytes: (size) => {
      seq += 1;
      const buf = Buffer.alloc(size, seq);
      return buf;
    },
    configDir,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
    processExists: (pid) => pid === process.pid,
    sleepMs: () => undefined,
    homedir: configDir,
    env: {},
  };
}

function planPayload(
  root: string,
  prompt: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    composer_mode: "plan",
    cursor_version: "3.21.16",
    conversation_id: "conversation-1",
    workspace_roots: [root],
    attachments: [{ type: "rule", file_path: "/global-rule.md" }],
    prompt,
    generation_id: "gen-plan-1",
    transcript_path: null,
    ...extras,
  };
}

function input(
  root: string,
  payload: unknown,
  event: "prompt.submit" | "agent.response" = "prompt.submit",
): HookDispatchInput {
  return { host: "cursor", event, projectRoot: root, payload };
}

describe("decideCursorPlanChoice", () => {
  it("passes Agent/Ask without creating state and blocks the first Plan with a token question", () => {
    const root = workspace();
    const clock = { value: 1_000_000 };
    const d = deps(clock);
    const agent = decideCursorPlanChoice(
      input(root, { composer_mode: "agent", prompt: "hi", attachments: [{ type: "rule" }] }),
      d,
    );
    expect(agent.verdict).toBe("allow");
    expect(agent.code).toBe("plan-choice-allow-non-plan");

    const first = decideCursorPlanChoice(
      input(root, planPayload(root, "please plan the slice")),
      d,
    );
    expect(first.verdict).toBe("deny");
    expect(first.code).toBe("plan-choice-question");
    expect(first.message).toContain("DEFT-PLAN-CHOICE");
    expect(first.message).toContain("1. Directive planning (recommended)");
    expect(first.message).not.toContain("please plan the slice");
    const token = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(first.message)?.[1];
    expect(token).toHaveLength(32);

    const retry = decideCursorPlanChoice(
      input(root, planPayload(root, "please plan the slice")),
      d,
    );
    expect(retry.message).toContain(token ?? "missing");
  });

  it("accepts an exact answer even when global rule attachments are present", () => {
    const root = workspace();
    const clock = { value: 2_000_000 };
    const d = deps(clock);
    const question = decideCursorPlanChoice(input(root, planPayload(root, "plan now")), d);
    const token = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(question.message)?.[1];
    expect(token).toBeTruthy();
    const answer = `DEFT-PLAN-CHOICE ${token} 1`;
    expect(parsePlanChoiceAnswer(answer)?.choice).toBe(1);
    const selected = decideCursorPlanChoice(input(root, planPayload(root, answer)), d);
    expect(selected.verdict).toBe("deny");
    expect(selected.code).toBe("plan-choice-idempotent-receipt");
    expect(selected.message).toContain("Recorded: Directive planning");
    expect(selected.message).toContain("/deft:directive:run:interview");

    const duplicate = decideCursorPlanChoice(input(root, planPayload(root, answer)), d);
    expect(duplicate.code).toBe("plan-choice-idempotent-receipt");

    const stale = decideCursorPlanChoice(
      input(root, planPayload(root, `DEFT-PLAN-CHOICE ${token} 2`)),
      d,
    );
    expect(stale.verdict).toBe("deny");
    expect(stale.message).toContain("Recorded: Directive planning");
  });

  it("requires the interview command before allowing Directive Plan work, then acks a matching generation", () => {
    const root = workspace();
    const clock = { value: 3_000_000 };
    const d = deps(clock);
    const question = decideCursorPlanChoice(input(root, planPayload(root, "plan")), d);
    const token = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(question.message)?.[1];
    decideCursorPlanChoice(input(root, planPayload(root, `DEFT-PLAN-CHOICE ${token} 1`)), d);

    const blocked = decideCursorPlanChoice(input(root, planPayload(root, "continue planning")), d);
    expect(blocked.code).toBe("plan-choice-handoff-required");

    const handoff = decideCursorPlanChoice(
      input(
        root,
        planPayload(root, "/deft:directive:run:interview design the planning join", {
          generation_id: "gen-handoff",
        }),
      ),
      d,
    );
    expect(handoff.verdict).toBe("allow");
    expect(handoff.code).toBe("plan-choice-allow-interview");

    const ignored = decideCursorPlanChoice(
      input(
        root,
        {
          conversation_id: "conversation-1",
          workspace_roots: [root],
          generation_id: "other-gen",
        },
        "agent.response",
      ),
      d,
    );
    expect(ignored.code).toBe("plan-choice-ack-ignored");

    const ack = decideCursorPlanChoice(
      input(
        root,
        {
          conversation_id: "conversation-1",
          workspace_roots: [root],
          generation_id: "gen-handoff",
        },
        "agent.response",
      ),
      d,
    );
    expect(ack.code).toBe("plan-choice-ack-observed");

    const follow = decideCursorPlanChoice(input(root, planPayload(root, "Light path please")), d);
    expect(follow.verdict).toBe("allow");
    expect(follow.code).toBe("plan-choice-allow-followup");
  });

  it("allows the next ordinary Plan prompt after a host-only choice", () => {
    const root = workspace();
    const clock = { value: 4_000_000 };
    const d = deps(clock);
    const question = decideCursorPlanChoice(input(root, planPayload(root, "plan")), d);
    const token = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(question.message)?.[1];
    const receipt = decideCursorPlanChoice(
      input(root, planPayload(root, `DEFT-PLAN-CHOICE ${token} 2`)),
      d,
    );
    expect(receipt.message).toContain("host-only planning");
    const next = decideCursorPlanChoice(input(root, planPayload(root, "draw the host plan")), d);
    expect(next.verdict).toBe("allow");
    expect(next.code).toBe("plan-choice-allow-host-only");
  });

  it("isolates two conversations and does not treat Discuss/Back as consent", () => {
    const root = workspace();
    const clock = { value: 5_000_000 };
    const d = deps(clock);
    const q1 = decideCursorPlanChoice(input(root, planPayload(root, "one")), d);
    const token1 = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(q1.message)?.[1];
    const q2 = decideCursorPlanChoice(
      input(root, planPayload(root, "two", { conversation_id: "conversation-2" })),
      d,
    );
    const token2 = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(q2.message)?.[1];
    expect(token1).not.toBe(token2);

    const cross = decideCursorPlanChoice(
      input(root, planPayload(root, `DEFT-PLAN-CHOICE ${token2} 1`)),
      d,
    );
    expect(cross.code).toBe("plan-choice-question");

    const discuss = decideCursorPlanChoice(
      input(root, planPayload(root, `DEFT-PLAN-CHOICE ${token1} 3`)),
      d,
    );
    expect(discuss.code).toBe("plan-choice-discuss");
    const again = decideCursorPlanChoice(input(root, planPayload(root, "still planning")), d);
    expect(again.code).toBe("plan-choice-question");
    expect(again.message).not.toContain(token1 ?? "missing");

    const token3 = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(again.message)?.[1];
    const back = decideCursorPlanChoice(
      input(root, planPayload(root, `DEFT-PLAN-CHOICE ${token3} 4`)),
      d,
    );
    expect(back.code).toBe("plan-choice-back");
  });

  it("does not persist user project prompt text", () => {
    const root = workspace();
    const clock = { value: 6_000_000 };
    const d = deps(clock);
    decideCursorPlanChoice(input(root, planPayload(root, "SECRET-PROJECT-PROMPT")), d);
    const storeRoot = join(d.configDir, "runtime", "cursor-plan-choice", "v1");
    const bodies: string[] = [];
    for (const ws of readdirSync(storeRoot)) {
      for (const file of readdirSync(join(storeRoot, ws))) {
        if (file.endsWith(".json")) {
          bodies.push(readFileSync(join(storeRoot, ws, file), "utf8"));
        }
      }
    }
    expect(bodies.join("")).not.toContain("SECRET-PROJECT-PROMPT");
    expect(bodies.join("")).toContain("cursor-plan-choice.q1");
  });
});
