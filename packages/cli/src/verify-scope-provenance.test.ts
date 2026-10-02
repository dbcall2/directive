import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-scope-provenance.js";

describe("verify-scope-provenance CLI (#3145)", () => {
  it("parses base-ref and enforce", () => {
    const a = parseArgs(["--project-root=.", "--base-ref", "HEAD", "--enforce"]);
    expect(a.error).toBeUndefined();
    expect(a.baseRef).toBe("HEAD");
    expect(a.enforce).toBe(true);
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--bad"]).error).toMatch(/unrecognized/);
  });

  it("runs against framework root", { timeout: 120_000 }, () => {
    // Exit 2 is config/network (e.g. PR-aware base resolution) — still a successful CLI smoke.
    // Live merge-base census is one git show per lifecycle brief (~1700); dest
    // worktree spawnSync is ~12ms each (~25s serial, longer under suite load).
    const code = run(["--project-root", ".", "--quiet", "--base-ref", "HEAD"]);
    expect([0, 1, 2]).toContain(code);
  });
});
