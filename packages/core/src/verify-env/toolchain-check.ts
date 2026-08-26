import * as childProcess from "node:child_process";
import { win32 } from "node:path";
import {
  type PackageManager,
  type PackageManagerResolutionSource,
  packageManagerSourceLabel,
  resolveProjectPackageManager,
} from "../resolution/package-manager.js";
import { resolveCommandOnPath } from "./command-spawn.js";
import { nodeRuntimeRemediationLines } from "./node-runtime.js";

export interface ToolCheck {
  readonly name: string;
  readonly command: readonly string[];
}

export const MAINTAINER_TOOLS: readonly ToolCheck[] = [
  { name: "go", command: ["go", "version"] },
  { name: "uv", command: ["uv", "--version"] },
  { name: "git", command: ["git", "--version"] },
  { name: "gh", command: ["gh", "--version"] },
  { name: "node", command: ["node", "--version"] },
  { name: "pnpm", command: ["pnpm", "--version"] },
];

/** Consumer prerequisites shared by npm and pnpm projects. */
export const CONSUMER_TOOLS: readonly ToolCheck[] = [
  { name: "git", command: ["git", "--version"] },
  { name: "gh", command: ["gh", "--version"] },
  { name: "node", command: ["node", "--version"] },
];

const PACKAGE_MANAGER_TOOLS: Readonly<Record<PackageManager, ToolCheck>> = {
  npm: { name: "npm", command: ["npm", "--version"] },
  pnpm: { name: "pnpm", command: ["pnpm", "--version"] },
};

/** @deprecated use MAINTAINER_TOOLS */
export const TOOLS: readonly ToolCheck[] = MAINTAINER_TOOLS;

export type CommandRunner = (
  command: readonly string[],
  timeoutMs: number,
  options?: CommandRunnerOptions,
) =>
  | { returncode: number; stdout: string; stderr: string }
  | { error: "not-found" | "exception"; message: string };

export interface CommandRunnerOptions {
  /** Working directory whose package-manager contract the probe must observe. */
  readonly cwd?: string;
  /** Environment used for PATH lookup and subprocess execution. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ToolchainCheckResult {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
  readonly packageManager?: PackageManager;
  readonly packageManagerSource?: PackageManagerResolutionSource;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ToolchainExecFileOptions {
  readonly encoding: "utf8";
  readonly timeout: number;
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly shell: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type ToolchainExecFileSync = (
  bin: string,
  args: readonly string[],
  options: ToolchainExecFileOptions,
) => string;

export interface DefaultCommandRunnerOptions extends CommandRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly execFileSync?: ToolchainExecFileSync;
  readonly exists?: (path: string) => boolean;
}

interface CommandExecutionError {
  readonly code?: string;
  readonly status?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

function executionFailure(error: unknown): CommandExecutionError {
  return error as CommandExecutionError;
}

function failedExecution(error: unknown): {
  returncode: number;
  stdout: string;
  stderr: string;
} {
  const failure = executionFailure(error);
  return {
    returncode: typeof failure.status === "number" ? failure.status : 1,
    stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    stderr: typeof failure.stderr === "string" ? failure.stderr : String(failure.message ?? error),
  };
}

function windowsShellReportsMissing(error: unknown): boolean {
  const failure = executionFailure(error);
  if (failure.code === "ENOENT") return true;
  const diagnostic = `${failure.stderr ?? ""}\n${failure.message ?? ""}`;
  return /is not recognized as an internal or external command|command not found/i.test(diagnostic);
}

function isFixedWindowsPackageManagerProbe(bin: string, args: readonly string[]): boolean {
  return (bin === "npm" || bin === "pnpm") && args.length === 1 && args[0] === "--version";
}

function quoteWindowsCommandPath(path: string): string {
  return `"${path.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

function windowsCommandInterpreter(env: NodeJS.ProcessEnv): string {
  return win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
}

/** Execute one fixed tool argv with Windows `.cmd` fallback. */
export function defaultCommandRunner(
  command: readonly string[],
  timeoutMs: number,
  options: DefaultCommandRunnerOptions = {},
):
  | { returncode: number; stdout: string; stderr: string }
  | { error: "not-found" | "exception"; message: string } {
  const bin = command[0] ?? "";
  const args = command.slice(1);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execFileSync: ToolchainExecFileSync =
    options.execFileSync ??
    ((file, fileArgs, execOptions) =>
      childProcess.execFileSync(file, [...fileArgs], execOptions) as string);
  const execOptions: ToolchainExecFileOptions = {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    cwd: options.cwd,
    env,
  };

  // Windows package-manager shims are commonly .cmd files. Resolve an
  // absolute PATH candidate first so cmd.exe cannot select a repo-local shim,
  // then invoke the fixed `--version` probe through the system interpreter.
  if (platform === "win32" && isFixedWindowsPackageManagerProbe(bin, args)) {
    const resolvedBin = resolveCommandOnPath(bin, {
      env,
      platform,
      exists: options.exists,
    });
    if (resolvedBin === null) {
      return { error: "not-found", message: "" };
    }
    const isCommandShim = /\.(?:cmd|bat)$/i.test(resolvedBin);
    const executable = isCommandShim ? windowsCommandInterpreter(env) : resolvedBin;
    const executableArgs = isCommandShim
      ? ["/d", "/s", "/c", `${quoteWindowsCommandPath(resolvedBin)} --version`]
      : args;
    try {
      const stdout = execFileSync(executable, executableArgs, execOptions);
      return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
    } catch (error: unknown) {
      if (windowsShellReportsMissing(error)) {
        return { error: "not-found", message: "" };
      }
      return failedExecution(error);
    }
  }

  try {
    const stdout = execFileSync(bin, args, execOptions);
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = executionFailure(err);
    if (e.code === "ENOENT") {
      return { error: "not-found", message: "" };
    }
    return failedExecution(err);
  }
}

export interface ToolchainCheckOptions {
  readonly consumer?: boolean;
  /** Consumer project root used for package.json/lockfile resolution. */
  readonly projectRoot?: string;
  /** Environment map used for package-manager precedence. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Run maintainer or consumer toolchain probe (mirrors scripts/toolchain-check.py). */
export function runToolchainCheck(
  runner: CommandRunner = defaultCommandRunner,
  options: ToolchainCheckOptions = {},
  tools?: readonly ToolCheck[],
): ToolchainCheckResult {
  const lines: string[] = [];
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  let packageManager: PackageManager = "pnpm";
  let packageManagerSource: PackageManagerResolutionSource | undefined;
  let selectedTools: readonly ToolCheck[];

  if (tools !== undefined) {
    selectedTools = tools;
  } else if (options.consumer) {
    const resolution = resolveProjectPackageManager({
      projectRoot,
      env,
    });
    if (!resolution.ok) {
      lines.push(`  package manager: ERROR - ${resolution.message}`);
      lines.push("");
      lines.push("Package manager selection failed");
      return { lines, exitCode: 1 };
    }
    packageManager = resolution.packageManager;
    packageManagerSource = resolution.source;
    lines.push(
      `  package manager: ${packageManager} (${packageManagerSourceLabel(packageManagerSource)})`,
    );
    selectedTools = [...CONSUMER_TOOLS, PACKAGE_MANAGER_TOOLS[packageManager]];
  } else {
    selectedTools = MAINTAINER_TOOLS;
  }

  const missing: string[] = [];
  const failed: string[] = [];

  for (const tool of selectedTools) {
    const result = runner(tool.command, DEFAULT_TIMEOUT_MS, { cwd: projectRoot, env });
    if ("error" in result) {
      if (result.error === "not-found") {
        missing.push(tool.name);
        lines.push(`  ${tool.name}: NOT FOUND`);
      } else {
        failed.push(tool.name);
        lines.push(`  ${tool.name}: ERROR - ${result.message}`);
      }
      continue;
    }
    const version = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
    if (result.returncode === 0) {
      lines.push(`  ${tool.name}: ${version}`);
    } else {
      failed.push(tool.name);
      const diagnostic = firstSafeDiagnostic(result.stderr || result.stdout);
      lines.push(
        `  ${tool.name}: FAILED (exit ${result.returncode})${diagnostic === "" ? "" : ` - ${diagnostic}`}`,
      );
    }
  }

  lines.push("");
  const unavailable = [...missing, ...failed];
  if (unavailable.length > 0) {
    if (missing.length > 0) lines.push(`Missing tools: ${missing.join(", ")}`);
    if (failed.length > 0) lines.push(`Failed tools: ${failed.join(", ")}`);
    lines.push(...nodeRuntimeRemediationLines(unavailable, packageManager));
    return {
      lines,
      exitCode: 1,
      ...(options.consumer ? { packageManager, packageManagerSource } : {}),
    };
  }
  lines.push("All required tools available");
  return {
    lines,
    exitCode: 0,
    ...(options.consumer ? { packageManager, packageManagerSource } : {}),
  };
}

function firstSafeDiagnostic(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined || /^[A-Z][A-Z0-9_]*=/.test(first)) return "";
  const printable = [...first]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  return printable.length > 240 ? `${printable.slice(0, 237)}...` : printable;
}
