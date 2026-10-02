import {
  MARK_COMPLETE_NOT_AUTHORITY,
  SKILL_FILE_OPEN_NOT_COMPLETION,
} from "@deftai/directive-core/pre-pr-controller";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./pre-pr-run.js";

describe("deft pre-pr:run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a run and treats the id as a lookup hint", () => {
    const code = run([
      "--repo",
      "deftai/directive",
      "--base-sha",
      "aaa",
      "--head-sha",
      "bbb",
      "--tree-hash",
      "ccc",
      "--pr-body-hash",
      "ddd",
      "--approved-revision",
      "aaa",
      "--run-id",
      "ppr_cli",
      "--json",
    ]);
    expect(code).toBe(0);
  });

  it("refuses skill-open and mark-complete", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--skill-open"])).toBe(1);
    expect(err.join("")).toContain(SKILL_FILE_OPEN_NOT_COMPLETION);
    err.length = 0;
    expect(run(["--mark-complete", "--run-id", "ppr_x"])).toBe(1);
    expect(err.join("")).toContain(MARK_COMPLETE_NOT_AUTHORITY);
  });

  it("complete without observables does not mint a pass", () => {
    run([
      "--repo",
      "deftai/directive",
      "--base-sha",
      "aaa",
      "--head-sha",
      "bbb",
      "--tree-hash",
      "ccc",
      "--pr-body-hash",
      "ddd",
      "--approved-revision",
      "aaa",
      "--run-id",
      "ppr_cli_incomplete",
    ]);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--complete", "--run-id", "ppr_cli_incomplete"])).toBe(1);
    expect(err.join("")).toMatch(/required phase|omitted|incomplete/i);
  });

  it("parseArgs rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
  });

  it("covers help, equals-form flags, evaluate, and missing required args", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--help"])).toBe(0);
    expect(out.join("")).toContain("deft pre-pr:run");
    expect(run(["--complete"])).toBe(2);
    expect(run(["--evaluate", "--json"])).toBe(2);
    expect(
      run([
        "--evaluate",
        "--repo=deftai/directive",
        "--base-sha=aaa",
        "--head-sha=bbb",
        "--run-id=missing",
        "--json",
      ]),
    ).toBe(1);
    expect(run([])).toBe(2);
    const parsed = parseArgs([
      "--repo=deftai/directive",
      "--base-sha=aaa",
      "--head-sha=bbb",
      "--tree-hash=ccc",
      "--pr-body-hash=ddd",
      "--pr-node-id=PR_1",
      "--approved-revision=aaa",
      "--scope=a.ts",
      "--acceptance=ac",
      "--generation=2",
      "--skill-version=0.2",
      "--policy-version=2",
      "--run-id=ppr_eq",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.generation).toBe(2);
    expect(parsed.prNodeId).toBe("PR_1");
    expect(parseArgs(["--repo"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--generation", "0"]).error).toMatch(/positive integer/);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--policy-version", "2"]).policyVersion).toBe("2");
    expect(run(["--nope"])).toBe(2);
    expect(err.join("")).toMatch(/unrecognized/);
  });
});
