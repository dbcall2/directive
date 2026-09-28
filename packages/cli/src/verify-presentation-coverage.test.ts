import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-presentation-coverage.js";

describe("verify-presentation-coverage CLI (#5079)", () => {
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

  it("parses selectors and rejects missing option values", () => {
    expect(
      parseArgs([
        "--json",
        "--plan-id",
        "story",
        "--project-root=/tmp/project",
        "--origin-ref=main",
      ]),
    ).toMatchObject({
      json: true,
      planId: "story",
      projectRoot: "/tmp/project",
      originRef: "main",
    });
    for (const option of ["--project-root", "--origin-ref", "--plan-id"]) {
      expect(parseArgs([option])).toHaveProperty("error");
      expect(parseArgs([option, "--quiet"])).toHaveProperty("error");
    }
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--unknown"])).toBe(2);
    expect(run(["--project-root", "/nonexistent/coverage-project"])).toBe(2);
    expect(errors.mock.calls.flat().join("")).toContain("failed");
    errors.mockRestore();
  });
  it("rejects --base-ref", () => {
    const a = parseArgs(["--base-ref", "origin/master"]);
    expect(a.error).toMatch(/unrecognized argument: --base-ref/);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("emits real off-ceiling and malformed staged-authority JSON outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "coverage-cli-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      git("init", "--quiet");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Base");
      const base = git("rev-parse", "HEAD").trim();
      expect(run(["--project-root", root, "--origin-ref", base, "--quiet"])).toBe(0);
      expect(run(["--project-root", root, "--origin-ref", base])).toBe(0);
      expect(run(["--project-root", root, "--origin-ref", base, "--json"])).toBe(0);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
        code: 0,
        armed: false,
        coverage: [],
      });
      mkdirSync(join(root, ".deft"));
      writeFileSync(join(root, ".deft", "presentation-ceiling.json"), "{");
      git("add", ".");
      expect(run(["--project-root", root, "--origin-ref", base, "--staged", "--json"])).toBe(2);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 2 });
    } finally {
      output.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
