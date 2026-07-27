import { describe, expect, it } from "vitest";
import { probeAgentHooksLive } from "./agent-hooks-live-probe.js";

describe("probeAgentHooksLive", () => {
  it("reports empty stdout on allow fixture as non-functional (#2852)", () => {
    const result = probeAgentHooksLive("/project", {
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({
        fixture: "allow",
        issue: "empty-stdout",
      }),
      expect.objectContaining({
        fixture: "deny",
        issue: "empty-stdout",
      }),
    ]);
    expect(result.message).toContain("live probe FAILED");
  });

  it("reports unparseable stdout", () => {
    const result = probeAgentHooksLive("/project", {
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read") ? "not-json" : '{"permission":"deny"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({
        fixture: "allow",
        issue: "unparseable-json",
      }),
    ]);
  });

  it("reports missing deny on a known-deny fixture", () => {
    const result = probeAgentHooksLive("/project", {
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({
        status: 0,
        stdout: '{"permission":"allow"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({
        fixture: "deny",
        issue: "missing-deny",
      }),
    ]);
  });

  it("passes when allow and deny fixtures produce parseable decisions", () => {
    const result = probeAgentHooksLive("/project", {
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read")
          ? '{"permission":"allow"}'
          : '{"permission":"deny","user_message":"denied"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(0);
    expect(result.cases).toEqual([]);
  });

  it("returns unavailable when the hook command is missing from PATH", () => {
    const result = probeAgentHooksLive("/project", {
      resolveCommand: () => null,
    });

    expect(result.code).toBe(2);
    expect(result.cases[0]?.issue).toBe("hook-command-missing");
  });
});
