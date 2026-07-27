import { describe, expect, it, vi } from "vitest";
import { runAgentHooksHealthCheck } from "./main.js";
import { createPlainSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

describe("runAgentHooksHealthCheck", () => {
  it("records structural health and leaves Codex runtime trust unverifiable", () => {
    const lines: string[] = [];
    const findings: Finding[] = [];
    const registrations = [
      {
        host: "codex" as const,
        path: ".codex/hooks.json" as const,
        status: "healthy" as const,
        detail: "registrations are current",
      },
    ];
    const seams: DoctorSeams = {
      evaluateAgentHooks: () => ({
        code: 0,
        message: "registered",
        stream: "stdout",
        registrations,
      }),
    };

    runAgentHooksHealthCheck(
      "/project",
      true,
      false,
      createPlainSink({ write: (text) => lines.push(text) }),
      (finding) => findings.push(finding),
      seams,
    );

    expect(lines.join("")).toContain("registered and structurally valid");
    expect(lines.join("")).toContain("`/hooks`");
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "skip",
        check: "agent-hooks-registration",
        status: "registered",
        trust_status: "not-verifiable",
        registrations,
      }),
    ]);
  });

  it("runs the live probe only under doctor --full", () => {
    const findings: Finding[] = [];
    const liveProbe = vi.fn(() => ({
      code: 0 as const,
      message: "live probe passed",
      cases: [],
    }));
    const seams: DoctorSeams = {
      evaluateAgentHooks: () => ({
        code: 0,
        message: "registered",
        stream: "stdout",
        registrations: [],
      }),
      probeAgentHooksLive: liveProbe,
    };

    runAgentHooksHealthCheck(
      "/project",
      true,
      false,
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      seams,
    );
    expect(liveProbe).not.toHaveBeenCalled();

    runAgentHooksHealthCheck(
      "/project",
      true,
      true,
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      seams,
    );
    expect(liveProbe).toHaveBeenCalledTimes(1);
    expect(findings.at(-1)).toEqual(
      expect.objectContaining({
        status: "registered-and-functional",
        live_probe: "passed",
      }),
    );
  });

  it("surfaces empty-stdout hook bins as non-functional under --full", () => {
    const findings: Finding[] = [];
    runAgentHooksHealthCheck(
      "/project",
      true,
      true,
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [],
        }),
        probeAgentHooksLive: () => ({
          code: 1,
          message: "deft agent hooks live probe FAILED: allow: empty-stdout (empty stdout)",
          cases: [
            {
              host: "cursor",
              event: "tool.before",
              fixture: "allow",
              issue: "empty-stdout",
              detail: "empty stdout",
            },
          ],
        }),
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        check: "agent-hooks-live-probe",
        status: "non-functional",
        severity: "warning",
      }),
    ]);
  });

  it("reports registration drift without claiming runtime non-functionality", () => {
    const findings: Finding[] = [];
    runAgentHooksHealthCheck(
      "/project",
      true,
      false,
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 1,
          message: "registration incomplete",
          stream: "stderr",
          registrations: [],
        }),
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        status: "incomplete",
      }),
    ]);
  });

  it("distinguishes a registration probe configuration error", () => {
    const findings: Finding[] = [];
    runAgentHooksHealthCheck(
      "/project",
      true,
      false,
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 2,
          message: "project root unavailable",
          stream: "stderr",
          registrations: [],
        }),
      },
    );

    expect(findings).toEqual([expect.objectContaining({ status: "unavailable" })]);
  });

  it("reports a thrown registration probe without crashing doctor", () => {
    const findings: Finding[] = [];
    runAgentHooksHealthCheck(
      "/project",
      true,
      false,
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => {
          throw new Error("probe failed");
        },
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("probe failed"),
      }),
    ]);
  });
});
