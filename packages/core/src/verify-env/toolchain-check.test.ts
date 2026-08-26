import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatNamedCauseFailure } from "../check/named-cause.js";
import { NODE_RUNTIME_REMEDIATION, NPM_RUNTIME_REMEDIATION } from "./node-runtime.js";
import { CONSUMER_TOOLS, defaultCommandRunner, runToolchainCheck } from "./toolchain-check.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function consumerFixture(packageManager: string, pnpmLockPresent = false): string {
  const root = mkdtempSync(join(tmpdir(), "deft-toolchain-consumer-"));
  fixtureRoots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ packageManager })}\n`, "utf8");
  if (pnpmLockPresent) {
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }
  return root;
}

describe("runToolchainCheck", () => {
  it("reports all tools available on success", () => {
    const result = runToolchainCheck((command) => ({
      returncode: 0,
      stdout: `${command[0]} version test\n`,
      stderr: "",
    }));
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe("All required tools available");
  });

  it("reports missing tools with exit 1", () => {
    const result = runToolchainCheck(() => ({ error: "not-found", message: "" }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("Missing tools:"))).toBe(true);
  });

  it("reports command failures", () => {
    const result = runToolchainCheck(() => ({
      returncode: 1,
      stdout: "",
      stderr: "failed",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("FAILED"))).toBe(true);
  });

  it("sanitizes and bounds command-runner exception messages", () => {
    const result = runToolchainCheck(() => ({
      error: "exception",
      message: `failure\u009b31mRED\u202eBIDI\u0085INJECTED_BLOCK${"x".repeat(300)}`,
    }));
    const errorLines = result.lines.filter((line) => line.includes(": ERROR"));
    expect(errorLines.length).toBeGreaterThan(0);
    expect(errorLines.every((line) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line))).toBe(true);
    expect(errorLines.every((line) => line.includes("failure 31mRED BIDI"))).toBe(true);
    expect(errorLines.every((line) => !line.includes("INJECTED_BLOCK"))).toBe(true);
    expect(errorLines.every((line) => line.length < 280)).toBe(true);
  });

  it("emits node runtime remediation when node or pnpm is missing", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "node" || name === "pnpm") {
        return { error: "not-found", message: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(NODE_RUNTIME_REMEDIATION);
  });

  it("does not emit node remediation when only unrelated tools are missing", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "go") {
        return { error: "not-found", message: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).not.toContain(NODE_RUNTIME_REMEDIATION);
  });

  it("consumer mode probes shared tools plus the declared npm, never pnpm or go-task (#3610)", () => {
    const projectRoot = consumerFixture("npm@11.16.0", true);
    const seen: string[] = [];
    const probeRoots: Array<string | undefined> = [];
    const result = runToolchainCheck(
      (command, _timeoutMs, options) => {
        seen.push(command[0] ?? "");
        probeRoots.push(options?.cwd);
        return { returncode: 0, stdout: "ok\n", stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([...CONSUMER_TOOLS.map((tool) => tool.command[0]), "npm"]);
    expect(seen).not.toContain("go");
    expect(seen).not.toContain("uv");
    expect(seen).not.toContain("pnpm");
    expect(seen).not.toContain("task");
    expect(probeRoots.every((root) => root === projectRoot)).toBe(true);
    expect(result.lines.join("\n")).toMatch(/package manager: npm.*packageManager field/i);
  });

  it("probes pnpm for a pnpm-pinned consumer", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const seen: string[] = [];
    const result = runToolchainCheck(
      (command) => {
        seen.push(command[0] ?? "");
        return { returncode: 0, stdout: "ok\n", stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toContain("pnpm");
    expect(seen).not.toContain("npm");
    expect(seen).not.toContain("task");
  });

  it("does not invoke a Corepack-rejected pnpm shim in an npm-pinned fixture", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const seen: string[] = [];
    const result = runToolchainCheck(
      (command) => {
        const name = command[0] ?? "";
        seen.push(name);
        if (name === "pnpm") {
          return {
            returncode: 1,
            stdout: "",
            stderr:
              'This project is configured to use npm because package.json has a "packageManager" field',
          };
        }
        return { returncode: 0, stdout: `${name} ok\n`, stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).not.toContain("pnpm");
    expect(seen).toContain("npm");
  });

  it("fails before execution for an unsupported or instruction-shaped declaration", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0; touch should-not-run");
    const seen: string[][] = [];
    const result = runToolchainCheck(
      (command) => {
        seen.push([...command]);
        return { returncode: 0, stdout: "ok\n", stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(1);
    expect(seen).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/unsupported package manager/i);
    expect(result.lines.join("\n")).not.toContain("touch should-not-run --version");
  });

  it("emits npm-specific remediation without telling an npm project to enable pnpm", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainCheck(
      (command) =>
        command[0] === "npm"
          ? { error: "not-found" as const, message: "" }
          : { returncode: 0, stdout: "ok\n", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(NPM_RUNTIME_REMEDIATION);
    expect(result.lines).not.toContain(NODE_RUNTIME_REMEDIATION);
    expect(result.lines.join("\n")).not.toMatch(/corepack.*pnpm/i);
  });

  it("routes real consumer output to the failing npm cause and remedy", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const check = runToolchainCheck(
      (command) =>
        command[0] === "npm"
          ? { error: "not-found" as const, message: "" }
          : { returncode: 0, stdout: "ok\n", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    const named = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: check.exitCode,
      stdout: check.lines.join("\n"),
    });
    expect(named.cause).toMatch(/^npm: NOT FOUND$/i);
    expect(named.remedy).toMatch(/npm is bundled/i);
    expect(named.remedy).not.toMatch(/pnpm|corepack/i);
  });

  it("surfaces a real Corepack mismatch diagnostic from a nonzero manager probe", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const result = runToolchainCheck(
      (command) =>
        command[0] === "pnpm"
          ? {
              returncode: 1,
              stdout: "",
              stderr: "This project is configured to use npm",
            }
          : { returncode: 0, stdout: "ok\n", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.lines.join("\n")).toMatch(
      /pnpm: FAILED \(exit 1\) - This project is configured to use npm/,
    );
  });

  it("renders command output without Unicode line, terminal, or bidi controls", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const result = runToolchainCheck(
      (command) =>
        command[0] === "pnpm"
          ? {
              returncode: 1,
              stdout: "",
              stderr: "failure\u009b31mRED\u202eBIDI\u0085INJECTED_BLOCK",
            }
          : { returncode: 0, stdout: "ok\u009b0m\u202e\nINJECTED_SUCCESS", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    const output = result.lines.join("\n");
    expect(result.lines.every((line) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line))).toBe(true);
    expect(output).toContain("failure 31mRED BIDI");
    expect(output).not.toContain("INJECTED_BLOCK");
    expect(output).not.toContain("INJECTED_SUCCESS");
  });

  it.each(["darwin", "linux"] as const)("runs %s commands without a shell", (platform) => {
    const shells: boolean[] = [];
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform,
      execFileSync: (_bin, _args, options) => {
        shells.push(options.shell);
        return "11.16.0\n";
      },
    });
    expect(result).toMatchObject({ returncode: 0, stdout: "11.16.0\n" });
    expect(shells).toEqual([false]);
  });

  it("runs a trusted absolute Windows .cmd/PATHEXT shim through system cmd.exe", () => {
    const calls: Array<{
      bin: string;
      args: readonly string[];
      shell: boolean;
      windowsVerbatimArguments?: boolean;
      cwd?: string;
    }> = [];
    const managerPath = "C:\\Program Files\\nodejs\\npm.CMD";
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform: "win32",
      cwd: "C:\\consumer",
      env: { Path: "C:\\Program Files\\nodejs", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: (path) => path === managerPath,
      execFileSync: (bin, args, options) => {
        calls.push({
          bin,
          args,
          shell: options.shell,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          cwd: options.cwd,
        });
        return "11.16.0\r\n";
      },
    });
    expect(result).toMatchObject({ returncode: 0, stdout: "11.16.0\r\n" });
    expect(calls).toEqual([
      {
        bin: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npm.CMD" --version"'],
        shell: false,
        windowsVerbatimArguments: true,
        cwd: "C:\\consumer",
      },
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("C:\\consumer\\npm");
  });

  it.runIf(process.platform === "win32")(
    "executes a real Windows .cmd shim from a spaced PATH directory",
    () => {
      const shimRoot = mkdtempSync(join(tmpdir(), "deft toolchain shim-"));
      fixtureRoots.push(shimRoot);
      writeFileSync(join(shimRoot, "npm.cmd"), "@echo off\r\necho 11.16.0\r\n", "utf8");

      const result = defaultCommandRunner(["npm", "--version"], 1_000, {
        cwd: shimRoot,
        env: {
          ...process.env,
          PATH: shimRoot,
          Path: shimRoot,
          PATHEXT: ".CMD",
        },
      });

      expect(shimRoot).toContain(" ");
      expect(result).toMatchObject({ returncode: 0 });
      expect("stdout" in result ? result.stdout.trim() : "").toBe("11.16.0");
    },
  );

  it("never shell-retries arbitrary Windows argv", () => {
    const shells: boolean[] = [];
    const result = defaultCommandRunner(["npm", "--version & should-not-run"], 1_000, {
      platform: "win32",
      execFileSync: (_bin, _args, options) => {
        shells.push(options.shell);
        throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result).toEqual({ error: "not-found", message: "" });
    expect(shells).toEqual([false]);
  });

  it("preserves a Windows shim's real Corepack failure instead of relabeling it not-found", () => {
    const managerPath = "C:\\trusted\\pnpm.CMD";
    const result = defaultCommandRunner(["pnpm", "--version"], 1_000, {
      platform: "win32",
      env: { Path: "C:\\trusted", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: (path) => path === managerPath,
      execFileSync: () => {
        throw Object.assign(new Error("Corepack mismatch"), {
          status: 1,
          stdout: "",
          stderr: "This project is configured to use npm",
        });
      },
    });
    expect(result).toEqual({
      returncode: 1,
      stdout: "",
      stderr: "This project is configured to use npm",
    });
  });

  it("does not execute a repo-local Windows manager when PATH has no trusted candidate", () => {
    let called = false;
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform: "win32",
      cwd: "C:\\consumer",
      env: { Path: "C:\\trusted", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: () => false,
      execFileSync: () => {
        called = true;
        return "unexpected";
      },
    });
    expect(result).toEqual({ error: "not-found", message: "" });
    expect(called).toBe(false);
  });
});
