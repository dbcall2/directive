import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-hooks-installed.js";

const ok = { code: 0 as const, message: "ok", stream: "stdout" as const };

describe("verify-hooks-installed --live", () => {
  it("keeps the default scope git-only", () => {
    expect(parseArgs([])).toMatchObject({ scope: "git", live: false });
  });

  it("rejects --live without an agent scope", () => {
    const writes: string[] = [];
    const code = run(["--live"], {
      writeErr: (text) => writes.push(text),
    });

    expect(code).toBe(2);
    expect(writes.join("")).toContain("--live requires --scope=agent or --scope=all");
  });

  it("uses functional readiness for --scope=agent --live", () => {
    const evaluateGit = vi.fn(() => ok);
    const evaluateAgent = vi.fn(() => ({ ...ok, registrations: [] }));
    const evaluateReadiness = vi.fn(() => ({
      ...ok,
      skipped: false,
      liveStatus: "functional" as const,
      hosts: [],
      registrations: [],
      liveProbe: null,
    }));

    const code = run(["--scope=agent", "--live", "--quiet"], {
      evaluateGit,
      evaluateAgent,
      evaluateReadiness,
    });

    expect(code).toBe(0);
    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    expect(evaluateAgent).not.toHaveBeenCalled();
    expect(evaluateGit).not.toHaveBeenCalled();
  });

  it("combines git and live agent exit codes for --scope=all", () => {
    const code = run(["--scope=all", "--live", "--quiet"], {
      evaluateGit: () => ok,
      evaluateReadiness: () => ({
        code: 1,
        message: "non-functional",
        stream: "stderr",
        skipped: false,
        liveStatus: "non-functional",
        hosts: [],
        registrations: [],
        liveProbe: null,
      }),
    });

    expect(code).toBe(1);
  });

  it.each([
    [["--project-root"], "--project-root: expected one argument"],
    [["--scope"], "--scope: expected one argument"],
    [["--scope", "bogus"], "--scope: invalid choice"],
    [["--scope=bogus"], "--scope: invalid choice"],
    [["--bogus"], "unrecognized arguments"],
  ])("rejects malformed arguments %j", (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject({ error: expect.stringContaining(expected) });
  });

  it("parses separated and inline project roots plus a separated scope", () => {
    expect(parseArgs(["--project-root", "/one", "--scope", "agent"])).toMatchObject({
      projectRoot: "/one",
      scope: "agent",
    });
    expect(parseArgs(["--project-root=/two", "--scope=all"])).toMatchObject({
      projectRoot: "/two",
      scope: "all",
    });
  });

  it("uses structural agent verification without --live and writes its stderr message", () => {
    const errors: string[] = [];
    const evaluateReadiness = vi.fn();
    const code = run(["--scope=agent"], {
      evaluateAgent: () => ({
        code: 1,
        message: "registration drifted",
        stream: "stderr",
        registrations: [],
      }),
      evaluateReadiness,
      writeErr: (text) => errors.push(text),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(["registration drifted\n"]);
    expect(evaluateReadiness).not.toHaveBeenCalled();
  });

  it("writes successful git verification to stdout", () => {
    const output: string[] = [];
    const code = run([], {
      evaluateGit: () => ok,
      writeOut: (text) => output.push(text),
    });

    expect(code).toBe(0);
    expect(output).toEqual(["ok\n"]);
  });

  it("uses process output streams when writer seams are omitted", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = run(["--scope=all"], {
      evaluateGit: () => ok,
      evaluateAgent: () => ({
        code: 1,
        message: "agent drifted",
        stream: "stderr",
        registrations: [],
      }),
    });

    expect(code).toBe(1);
    expect(stdout).toHaveBeenCalledWith("ok\n");
    expect(stderr).toHaveBeenCalledWith("agent drifted\n");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("fails closed when an injected readiness evaluator throws", () => {
    const errors: string[] = [];
    const code = run(["--scope=agent", "--live"], {
      evaluateReadiness: () => {
        throw "readiness exploded";
      },
      writeErr: (text) => errors.push(text),
    });

    expect(code).toBe(2);
    expect(errors.join("")).toContain("readiness exploded");
  });
});
