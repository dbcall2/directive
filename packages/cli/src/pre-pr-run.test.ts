import { afterEach, describe, expect, it, vi } from "vitest";
import { MARK_COMPLETE_NOT_AUTHORITY, SKILL_FILE_OPEN_NOT_COMPLETION } from "@deftai/directive-core/pre-pr-controller";
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
});
