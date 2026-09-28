import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-presentation-ceiling.js";

describe("verify-presentation-ceiling CLI (#5079)", () => {
  it("parses project-root, origin-ref, staged, quiet", () => {
    const a = parseArgs([
      "--project-root",
      ".",
      "--origin-ref",
      "origin/master",
      "--quiet",
      "--staged",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe(".");
    expect(a.originRef).toBe("origin/master");
    expect(a.quiet).toBe(true);
    expect(a.staged).toBe(true);
  });

  it("rejects --base-ref", () => {
    const a = parseArgs(["--base-ref", "origin/master"]);
    expect(a.error).toMatch(/unrecognized argument: --base-ref/);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("runs against framework root without config error", () => {
    const code = run(["--project-root", ".", "--quiet"]);
    expect([0, 1, 2]).toContain(code);
  }, 30_000);
});
