import { describe, expect, it, vi } from "vitest";
import {
  DIRECT_WRITE_TOOL_NAMES,
  decideHook,
  type HookPolicySeams,
  hookToolName,
  isDirectWriteTool,
  isHookEvent,
  isHookHost,
  projectRootFromHookPayload,
  renderHostDecision,
} from "./index.js";

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

function readySeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    inspectRitual: () => READY_RITUAL,
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

describe("direct-write hook policy", () => {
  it("allows non-write tools without consulting mutation gates", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Read", cwd: "/project" },
      },
      readySeams({ inspectRitual }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "not-direct-write" });
    expect(inspectRitual).not.toHaveBeenCalled();
  });

  it("denies a direct write when the gated ritual is not fresh", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { toolName: "Edit", workspaceRoot: "/project" },
      },
      readySeams({
        inspectRitual: () => ({
          ...READY_RITUAL,
          code: 1,
          message: "ritual state missing",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(decision.message).toContain("deft session:start");
    expect(decision.message).toContain("deft verify:session-ritual -- --tier=gated");
  });

  it("denies a direct write when no active running scope passes preflight", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "StrReplace", workspace_roots: ["/project"] },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active/running xBRIEF is available.",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("deft scope:activate -- <path>");
  });

  it("allows a direct write only when both canonical predicates pass", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Write", cwd: "/project" },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(decision.scopePath).toBe(READY_SCOPE.path);
  });

  it("fails closed when a matched tool event omits its tool name", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "invalid-input" });
  });

  it("surfaces a failed SessionStart result without blocking the session", () => {
    const sessionStart = vi.fn(() => ({ code: 2, stdout: "", stderr: "no active scope" }));
    const decision = decideHook(
      {
        host: "grok",
        event: "session.start",
        projectRoot: "/project",
        payload: { hookEventName: "SessionStart", workspaceRoot: "/project" },
      },
      readySeams({ sessionStart }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-degraded" });
    expect(decision.message).toContain("exit 2");
    expect(decision.message).toContain("no active scope");
    expect(sessionStart).toHaveBeenCalledWith("/project");
  });

  it("keeps SessionStart non-blocking when bookkeeping throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart: () => {
          throw new Error("read-only bookkeeping failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-degraded" });
    expect(decision.message).toContain("read-only bookkeeping failed");
  });

  it("fails closed when ritual inspection throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool: "Write" },
      },
      readySeams({
        inspectRitual: () => {
          throw new Error("probe failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(decision.message).toContain("probe failed");
  });

  it("fails closed when active-scope inspection throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Edit" },
      },
      readySeams({
        inspectScope: () => {
          throw new Error("scope probe failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("scope probe failed");
  });
});

describe("provider codecs", () => {
  const deny = decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: "/project",
      payload: { toolName: "Write" },
    },
    readySeams({
      inspectRitual: () => ({ ...READY_RITUAL, code: 1, message: "stale" }),
    }),
  );

  it("renders Claude's hookSpecificOutput denial", () => {
    expect(JSON.parse(renderHostDecision("claude", deny))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("renders Grok's native decision denial", () => {
    expect(JSON.parse(renderHostDecision("grok", deny))).toMatchObject({
      decision: "deny",
    });
  });

  it("renders Cursor's permission denial", () => {
    expect(JSON.parse(renderHostDecision("cursor", deny))).toMatchObject({
      permission: "deny",
    });
  });

  it("emits no provider override for an allow decision", () => {
    const allow = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Read" },
      },
      readySeams(),
    );
    expect(renderHostDecision("claude", allow)).toBe("");
    expect(renderHostDecision("grok", allow)).toBe("");
    expect(renderHostDecision("cursor", allow)).toBe("");
  });
});

describe("direct-write classifier", () => {
  it.each([...DIRECT_WRITE_TOOL_NAMES])("classifies %s as a direct write", (tool) =>
    expect(isDirectWriteTool(tool)).toBe(true));

  it.each([
    "Read",
    "Grep",
    "Shell",
    "Bash",
    "Task",
    "WebSearch",
  ])("leaves %s outside the P0 direct-write slice", (tool) =>
    expect(isDirectWriteTool(tool)).toBe(false));
});

describe("provider input normalization", () => {
  it("accepts snake_case, camelCase, and generic tool names", () => {
    expect(hookToolName({ tool_name: "Write" })).toBe("Write");
    expect(hookToolName({ toolName: "Edit" })).toBe("Edit");
    expect(hookToolName({ tool: "Delete" })).toBe("Delete");
    expect(hookToolName(null)).toBeNull();
    expect(hookToolName({ tool_name: "  " })).toBeNull();
  });

  it("resolves supported workspace-root spellings with a fallback", () => {
    expect(projectRootFromHookPayload(null, "/fallback")).toBe("/fallback");
    expect(projectRootFromHookPayload({ workspace_root: "/snake" }, "/fallback")).toBe("/snake");
    expect(projectRootFromHookPayload({ workspace_roots: ["/array"] }, "/fallback")).toBe("/array");
    expect(projectRootFromHookPayload({ cwd: "/cwd" }, "/fallback")).toBe("/cwd");
    expect(projectRootFromHookPayload({}, "/fallback")).toBe("/fallback");
  });

  it("validates public host and event identifiers", () => {
    expect(isHookHost("cursor")).toBe(true);
    expect(isHookHost("opencode")).toBe(false);
    expect(isHookEvent("session.start")).toBe(true);
    expect(isHookEvent("tool.after")).toBe(false);
  });
});
