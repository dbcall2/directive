import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { HookEvent, HookHost } from "../hooks/dispatcher.js";
import { READ_ONLY_HOOK_ENV } from "../hooks/tools.js";
import { DEFT_HOOK_COMMAND_MARKER } from "../init-deposit/agent-hooks.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import {
  quoteWin32CommandForShell,
  resolveCommandOnPath,
  shouldUseShellForCommand,
} from "./command-spawn.js";

export type AgentHookLiveProbeIssue =
  | "hook-command-missing"
  | "spawn-failed"
  | "empty-stdout"
  | "unparseable-json"
  | "missing-allow"
  | "missing-deny";

export interface AgentHookLiveProbeCase {
  readonly host: HookHost;
  readonly event: HookEvent;
  readonly fixture: "allow" | "deny";
  readonly issue: AgentHookLiveProbeIssue;
  readonly detail: string;
}

export interface AgentHookLiveProbeResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly cases: readonly AgentHookLiveProbeCase[];
}

export interface AgentHookLiveProbeSeams {
  readonly resolveCommand?: (name: string) => string | null;
  readonly spawnHook?: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly stdin: string;
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  }) => { readonly status: number; readonly stdout: string; readonly stderr: string };
}

interface ResolvedHookCommand {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

interface CursorDecision {
  readonly ok: boolean;
  readonly permission?: "allow" | "deny";
  readonly detail: string;
}

const LIVE_PROBE_HOST: HookHost = "cursor";
const LIVE_PROBE_EVENT: HookEvent = "tool.before";

function resolveHookCommand(seams: AgentHookLiveProbeSeams): ResolvedHookCommand | null {
  const resolveCommand = seams.resolveCommand ?? resolveCommandOnPath;
  const deftHook = resolveCommand(DEFT_HOOK_COMMAND_MARKER);
  if (deftHook !== null) {
    return { command: deftHook, argsPrefix: [] };
  }
  const deft = resolveCommand("deft");
  if (deft !== null) {
    return { command: deft, argsPrefix: ["hook:dispatch"] };
  }
  const directive = resolveCommand("directive");
  if (directive !== null) {
    return { command: directive, argsPrefix: ["hook:dispatch"] };
  }
  return null;
}

export function quoteWindowsCmdArg(value: string): string {
  const escaped = value.replace(/%/g, "%%");
  if (!/[\s"&|<>^()]/.test(escaped)) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

function spawnHookWithStdin(
  command: string,
  args: readonly string[],
  stdin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stdout: string; stderr: string } {
  const shell = shouldUseShellForCommand(command);
  if (shell && process.platform === "win32") {
    const cmdLine = [quoteWin32CommandForShell(command), ...args.map(quoteWindowsCmdArg)].join(" ");
    const proc = spawnSync(cmdLine, [], {
      input: stdin,
      cwd,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    const status = proc.status ?? (proc.error ? 2 : proc.signal ? 128 : 0);
    return {
      status,
      stdout: typeof proc.stdout === "string" ? proc.stdout : "",
      stderr: typeof proc.stderr === "string" ? proc.stderr : "",
    };
  }

  const spawnCmd =
    shell && process.platform === "win32" ? quoteWin32CommandForShell(command) : command;
  const proc = spawnSync(spawnCmd, [...args], {
    input: stdin,
    cwd,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  const status = proc.status ?? (proc.error ? 2 : proc.signal ? 128 : 0);
  return {
    status,
    stdout: typeof proc.stdout === "string" ? proc.stdout : "",
    stderr: typeof proc.stderr === "string" ? proc.stderr : "",
  };
}

function allowFixture(projectRoot: string): string {
  return JSON.stringify({
    tool_name: "Read",
    cwd: projectRoot,
    workspace_roots: [projectRoot],
  });
}

function denyFixture(projectRoot: string): string {
  return JSON.stringify({
    tool_name: "Task",
    cwd: projectRoot,
    workspace_roots: [projectRoot],
    tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
  });
}

function denyProbeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [READ_ONLY_HOOK_ENV]: "1" };
}

function parseCursorDecision(stdout: string): CursorDecision {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, detail: "empty stdout" };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).permission === "allow"
    ) {
      return { ok: true, permission: "allow", detail: "permission allow" };
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).permission === "deny"
    ) {
      return { ok: true, permission: "deny", detail: "permission deny" };
    }
    return { ok: false, detail: "stdout JSON missing permission allow/deny" };
  } catch {
    return { ok: false, detail: "stdout is not valid JSON" };
  }
}

function runFixtureProbe(
  resolved: ResolvedHookCommand,
  projectRoot: string,
  fixture: "allow" | "deny",
  stdin: string,
  env: NodeJS.ProcessEnv,
  spawnHook: NonNullable<AgentHookLiveProbeSeams["spawnHook"]>,
): AgentHookLiveProbeCase | null {
  const args = [
    ...resolved.argsPrefix,
    "--host",
    LIVE_PROBE_HOST,
    "--event",
    LIVE_PROBE_EVENT,
    "--project-root",
    projectRoot,
  ];
  const spawned = spawnHook({
    command: resolved.command,
    args,
    stdin,
    cwd: projectRoot,
    env,
  });
  if (spawned.status !== 0) {
    return {
      host: LIVE_PROBE_HOST,
      event: LIVE_PROBE_EVENT,
      fixture,
      issue: "spawn-failed",
      detail: `hook command exited ${spawned.status}${spawned.stderr.trim() ? `: ${spawned.stderr.trim()}` : ""}`,
    };
  }

  const decision = parseCursorDecision(spawned.stdout);
  if (!decision.ok) {
    return {
      host: LIVE_PROBE_HOST,
      event: LIVE_PROBE_EVENT,
      fixture,
      issue: decision.detail.includes("JSON") ? "unparseable-json" : "empty-stdout",
      detail: decision.detail,
    };
  }

  if (fixture === "allow" && decision.permission !== "allow") {
    return {
      host: LIVE_PROBE_HOST,
      event: LIVE_PROBE_EVENT,
      fixture,
      issue: "missing-allow",
      detail: `expected permission allow, got ${decision.permission ?? "none"}`,
    };
  }
  if (fixture === "deny" && decision.permission !== "deny") {
    return {
      host: LIVE_PROBE_HOST,
      event: LIVE_PROBE_EVENT,
      fixture,
      issue: "missing-deny",
      detail: `expected permission deny, got ${decision.permission ?? "none"}`,
    };
  }
  return null;
}

/** Spawn the configured hook command and assert Cursor tool.before allow/deny behavior. */
export function probeAgentHooksLive(
  projectRoot: string,
  seams: AgentHookLiveProbeSeams = {},
): AgentHookLiveProbeResult {
  const root = resolve(projectRoot);
  const resolved = resolveHookCommand(seams);
  if (resolved === null) {
    return {
      code: 2,
      message:
        "deft agent hooks live probe unavailable: neither deft-hook nor deft/directive hook:dispatch is on PATH.",
      cases: [
        {
          host: LIVE_PROBE_HOST,
          event: LIVE_PROBE_EVENT,
          fixture: "allow",
          issue: "hook-command-missing",
          detail: `${DEFT_HOOK_COMMAND_MARKER} not found on PATH`,
        },
      ],
    };
  }

  const spawnHook =
    seams.spawnHook ??
    ((input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly stdin: string;
      readonly cwd: string;
      readonly env?: NodeJS.ProcessEnv;
    }) =>
      spawnHookWithStdin(
        input.command,
        input.args,
        input.stdin,
        input.cwd,
        input.env ?? process.env,
      ));
  const failures: AgentHookLiveProbeCase[] = [];
  for (const [fixture, stdin, env] of [
    ["allow", allowFixture(root), process.env] as const,
    ["deny", denyFixture(root), denyProbeEnv()] as const,
  ]) {
    const failure = runFixtureProbe(resolved, root, fixture, stdin, env, spawnHook);
    if (failure !== null) failures.push(failure);
  }

  if (failures.length === 0) {
    return {
      code: 0,
      message: "deft agent hooks live probe passed for Cursor tool.before allow and deny fixtures.",
      cases: [],
    };
  }

  const summary = failures
    .map((entry) => `${entry.fixture}: ${entry.issue} (${entry.detail})`)
    .join("; ");
  return {
    code: 1,
    message: `deft agent hooks live probe FAILED: ${summary}. Recovery: reinstall @deftai/directive and run \`deft update\`.`,
    cases: failures,
  };
}
