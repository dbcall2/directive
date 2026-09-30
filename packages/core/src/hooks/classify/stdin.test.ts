import { describe, expect, it } from "vitest";
import {
  applyPatchBodyFieldTexts,
  applyPatchHarvestedInputUnclassified,
  applyPatchHasCanonicalEnvelope,
  applyPatchMutationPaths,
  parseHookStdin,
  stripUtf8Bom,
} from "./stdin.js";

describe("parseHookStdin (#2734 / #2738 / #2950)", () => {
  it("strips BOM and parses JSON", () => {
    expect(stripUtf8Bom("\uFEFFhi")).toBe("hi");
    const payload = { tool_name: "Write", tool_input: { path: "a.txt" } };
    expect(parseHookStdin(`\uFEFF${JSON.stringify(payload)}`)).toEqual({
      payload,
      context: {},
    });
  });

  it("tags empty and parse failures", () => {
    expect(parseHookStdin("")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parseHookStdin("\uFEFF")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parseHookStdin("{bad")).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("lands process_only from Grok PreToolUse stdin onto tool_input (#4315)", () => {
    const raw = JSON.stringify({
      hookEventName: "pre_tool_use",
      hook_event_name: "PreToolUse",
      toolName: "spawn_subagent",
      toolInput: {
        subagent_type: "general-purpose",
        process_only: true,
        cwd: "/dest",
        prompt: "git show the dispatch sha",
      },
    });
    const parsed = parseHookStdin(raw);
    const payload = parsed.payload as {
      tool_input?: { process_only?: boolean; subagent_type?: string; cwd?: string };
    };
    expect(payload.tool_input?.process_only).toBe(true);
    expect(payload.tool_input?.subagent_type).toBe("general-purpose");
    expect(payload.tool_input?.cwd).toBe("/dest");
  });

  it("synthesizes single-file free-form ApplyPatch", () => {
    const freeForm = ["*** Begin Patch", "*** Add File: only.txt", "+x", "*** End Patch"].join(
      "\n",
    );
    expect(parseHookStdin(freeForm)).toEqual({
      payload: {
        tool_name: "ApplyPatch",
        tool_input: { path: "only.txt", patch: freeForm },
      },
      context: {},
    });
  });
});

describe("applyPatchMutationPaths (#3794)", () => {
  it("collects mutation headers and `Move to` destinations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/from.ts",
      "*** Move to: /other/tree/to.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(applyPatchMutationPaths(patch)).toEqual(["src/from.ts", "/other/tree/to.ts"]);
  });

  it("drops duplicates across both header kinds", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: same.ts",
      "*** Move to: same.ts",
      "*** End Patch",
    ].join("\n");
    expect(applyPatchMutationPaths(patch)).toEqual(["same.ts"]);
  });

  it("does not synthesize a Move-to dual-target patch (#3614)", () => {
    // A rename is one header and two targets. Synthesis must refuse rather
    // than authorize the source while the write lands at the destination.
    const freeForm = [
      "*** Begin Patch",
      "*** Update File: from.txt",
      "*** Move to: to.txt",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(parseHookStdin(freeForm)).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("fills tool_input.path from string command on hyphenated apply-patch (#5094)", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/hyphen.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    const stdin = JSON.stringify({
      tool_name: "apply-patch",
      tool_input: { command: patch },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string; command?: string } };
    expect(payload.tool_input?.path).toBe("src/hyphen.ts");
    expect(payload.tool_input?.command).toBe(patch);
    expect(parsed.context).toEqual({});
  });

  it("fills tool_input.path from string command on JSON apply_patch (#5094)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/2026-08-21-story.xbrief.json",
      "+{}",
      "*** End Patch",
    ].join("\n");
    const stdin = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { command: patch },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string; command?: string } };
    expect(payload.tool_input?.path).toBe("xbrief/proposed/2026-08-21-story.xbrief.json");
    expect(payload.tool_input?.command).toBe(patch);
    expect(parsed.context).toEqual({});
  });

  it("does not synthesize path from Bash command that contains Begin Patch (#5094)", () => {
    const command = [
      "cat > notes.md <<'EOF'",
      "*** Begin Patch",
      "*** Add File: only.txt",
      "+x",
      "*** End Patch",
      "EOF",
    ].join("\n");
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string; command?: string } };
    expect(payload.tool_input?.path).toBeUndefined();
    expect(payload.tool_input?.command).toBe(command);
  });

  it("fills tool_input.path on valid JSON ApplyPatch with no declared path (#3614)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/2026-08-21-story.xbrief.json",
      "+{}",
      "*** End Patch",
    ].join("\n");
    const stdin = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { patch },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string; patch?: string } };
    expect(payload.tool_input?.path).toBe("xbrief/proposed/2026-08-21-story.xbrief.json");
    expect(payload.tool_input?.patch).toBe(patch);
    expect(parsed.context).toEqual({});
  });

  it("does not fill path on valid JSON Move-to dual-target ApplyPatch (#3614)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: xbrief/proposed/2026-08-21-story.xbrief.json",
      "*** Move to: src/index.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const stdin = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { patch },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string } };
    expect(payload.tool_input?.path).toBeUndefined();
  });
});

describe("declared ApplyPatch freeform input harvest (#5129)", () => {
  const patch = ["*** Begin Patch", "*** Update File: linked.ts", "+x", "*** End Patch"].join("\n");

  it("Begin/End helper requires both markers in order", () => {
    expect(applyPatchHasCanonicalEnvelope(patch)).toBe(true);
    expect(applyPatchHasCanonicalEnvelope("*** Begin Patch\n*** End Patch")).toBe(true);
    expect(applyPatchHasCanonicalEnvelope("*** Begin Patch\n*** Update File: a.ts\n+x")).toBe(
      false,
    );
    expect(applyPatchHasCanonicalEnvelope("*** End Patch\n*** Begin Patch")).toBe(false);
    expect(applyPatchHasCanonicalEnvelope("not a patch")).toBe(false);
  });

  it("fills tool_input.path from string tool_input.input", () => {
    const parsed = parseHookStdin(
      JSON.stringify({ tool_name: "apply_patch", tool_input: { input: patch } }),
    );
    const payload = parsed.payload as { tool_input?: { path?: string; input?: string } };
    expect(payload.tool_input?.path).toBe("linked.ts");
    expect(payload.tool_input?.input).toBe(patch);
    expect(applyPatchBodyFieldTexts(parsed.payload)).toEqual([patch]);
  });

  it("fills tool_input.path from top-level string payload.input", () => {
    const parsed = parseHookStdin(JSON.stringify({ tool_name: "apply_patch", input: patch }));
    const payload = parsed.payload as { input?: string; tool_input?: { path?: string } };
    expect(payload.input).toBe(patch);
    expect(payload.tool_input?.path).toBe("linked.ts");
    expect(applyPatchBodyFieldTexts(parsed.payload)).toEqual([patch]);
  });

  it("does not harvest raw-string tool_input", () => {
    const parsed = parseHookStdin(JSON.stringify({ tool_name: "apply_patch", tool_input: patch }));
    const payload = parsed.payload as { tool_input?: unknown };
    expect(payload.tool_input).toBe(patch);
    expect(applyPatchBodyFieldTexts(parsed.payload)).toEqual([]);
    expect(applyPatchHarvestedInputUnclassified(parsed.payload)).toBe(false);
  });

  it("does not synthesize path from Begin without End", () => {
    const body = "*** Begin Patch\n*** Add File: only.txt\n+x";
    expect(parseHookStdin(body)).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("marks non-canonical harvested input unclassified even with a declared path", () => {
    const payload = {
      tool_name: "apply_patch",
      tool_input: {
        path: "/project/src/a.ts",
        input: "not a patch\n*** Update File: /linked/src/a.ts\nnoise",
      },
    };
    expect(applyPatchHarvestedInputUnclassified(payload)).toBe(true);
    expect(applyPatchBodyFieldTexts(payload)).toEqual([]);
  });

  it("marks an empty Begin/End envelope unclassified", () => {
    expect(
      applyPatchHarvestedInputUnclassified({
        tool_name: "apply_patch",
        tool_input: { input: "*** Begin Patch\n*** End Patch" },
      }),
    ).toBe(true);
  });
});
