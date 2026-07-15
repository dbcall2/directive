import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_HOOK_PATHS,
  DIRECT_WRITE_HOOK_MATCHER,
  inspectAgentHookDeposit,
  writeAgentHookDeposit,
} from "./agent-hooks.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agent-hooks-"));
  temps.push(root);
  return root;
}

describe("writeAgentHookDeposit", () => {
  it("deposits native Claude, Grok, and Cursor SessionStart/direct-write hooks", () => {
    const root = project();
    const lines: string[] = [];
    const result = writeAgentHookDeposit(root, { printf: (text) => lines.push(text) });

    expect(result.changed).toBe(true);
    expect(result.changedPaths).toEqual([...AGENT_HOOK_PATHS]);
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain(
      "--host claude --event tool.before",
    );
    expect(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")).toContain(
      "--host grok --event tool.before",
    );
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(
      "--host cursor --event tool.before",
    );
    expect(DIRECT_WRITE_HOOK_MATCHER).toContain("WriteFile");
    expect(DIRECT_WRITE_HOOK_MATCHER).toContain("DeleteFile");
    expect(DIRECT_WRITE_HOOK_MATCHER).toContain("apply_patch");
    expect(lines.join("")).toContain("agent hooks");
    expect(inspectAgentHookDeposit(root).every((entry) => entry.status === "healthy")).toBe(true);
  });

  it("preserves unrelated settings and is byte-idempotent", () => {
    const root = project();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/settings.json"),
      `${JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "./custom-check.sh" }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    writeAgentHookDeposit(root);
    const first = AGENT_HOOK_PATHS.map((path) => readFileSync(join(root, path), "utf8"));
    const secondResult = writeAgentHookDeposit(root);
    const second = AGENT_HOOK_PATHS.map((path) => readFileSync(join(root, path), "utf8"));
    const claude = JSON.parse(second[0] ?? "{}") as Record<string, unknown>;

    expect(secondResult.changed).toBe(false);
    expect(second).toEqual(first);
    expect(claude.permissions).toEqual({ allow: ["Read"] });
    expect(second[0]).toContain("./custom-check.sh");
  });

  it("refuses to overwrite malformed user JSON", () => {
    const root = project();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor/hooks.json"), "{not-json\n", "utf8");

    expect(() => writeAgentHookDeposit(root)).toThrow(/not valid JSON/);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toBe("{not-json\n");
    expect(() => readFileSync(join(root, ".claude/settings.json"), "utf8")).toThrow();
    expect(() => readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")).toThrow();
  });
});

describe("inspectAgentHookDeposit", () => {
  it("distinguishes missing and drifted registrations", () => {
    const root = project();
    expect(inspectAgentHookDeposit(root).map((entry) => entry.status)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);

    writeAgentHookDeposit(root);
    const cursorPath = join(root, ".cursor/hooks.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    cursor.hooks.preToolUse[0] = { command: "echo bypass", matcher: "Edit" };
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
    });
  });
});
