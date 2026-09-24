import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyComposerMode, resolvePlanChoiceIdentity } from "./identity.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-choice-id-"));
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

describe("classifyComposerMode", () => {
  it("classifies plan, known non-Plan, missing, and unknown", () => {
    expect(classifyComposerMode("plan")).toBe("plan");
    expect(classifyComposerMode("agent")).toBe("known-non-plan");
    expect(classifyComposerMode("ask")).toBe("known-non-plan");
    expect(classifyComposerMode("")).toBe("missing");
    expect(classifyComposerMode("debug")).toBe("unknown");
  });
});

describe("resolvePlanChoiceIdentity", () => {
  it("lets known non-Plan modes pass without identity or version", () => {
    const result = resolvePlanChoiceIdentity(
      { composer_mode: "agent", prompt: "hello" },
      "/tmp/not-a-workspace",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modeClass).toBe("known-non-plan");
  });

  it("blocks an unverified cursor_version on Plan", () => {
    const result = resolvePlanChoiceIdentity(
      {
        composer_mode: "plan",
        cursor_version: "3.20.0",
        conversation_id: "c1",
        workspace_roots: ["/tmp/x"],
        attachments: [],
        prompt: "plan it",
      },
      "/tmp/x",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-surface");
  });

  it("blocks missing mode on the supported version", () => {
    const result = resolvePlanChoiceIdentity(
      { cursor_version: "3.21.16", conversation_id: "c1", attachments: [], prompt: "x" },
      "/tmp/x",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown-mode");
  });

  it("requires a unique workspace_roots entry matching the invocation root", () => {
    const root = workspace();
    const other = workspace();
    const payload = {
      composer_mode: "plan",
      cursor_version: "3.21.16",
      conversation_id: "conv-1",
      workspace_roots: [root, other],
      attachments: [{ type: "rule", file_path: "/rules" }],
      prompt: "plan this",
      generation_id: "gen-1",
    };
    const ambiguous = resolvePlanChoiceIdentity(payload, root);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.code).toBe("identity-invalid");

    const unique = resolvePlanChoiceIdentity({ ...payload, workspace_roots: [root] }, root);
    expect(unique.ok).toBe(true);
    if (unique.ok) {
      expect(unique.identity.conversationId).toBe("conv-1");
      expect(unique.identity.workspaceRoot).toBe(root);
      expect(unique.identity.workspaceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(unique.prompt).toBe("plan this");
      expect(unique.attachments).toHaveLength(1);
    }
  });

  it("rejects a non-array attachments field on Plan", () => {
    const root = workspace();
    const result = resolvePlanChoiceIdentity(
      {
        composer_mode: "plan",
        cursor_version: "3.21.16",
        conversation_id: "c1",
        workspace_roots: [root],
        attachments: "rules",
        prompt: "x",
      },
      root,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed");
  });
});
