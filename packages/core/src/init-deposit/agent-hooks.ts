import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertDepositContained } from "../deposit/contain.js";
import type { HookHost } from "../hooks/dispatcher.js";
import type { InitDepositIo } from "./constants.js";

export const DIRECT_WRITE_HOOK_MATCHER =
  "Edit|Write|WriteFile|CreateFile|MultiEdit|NotebookEdit|StrReplace|SearchReplace|Delete|DeleteFile|ApplyPatch|apply_patch";
export const DEFT_HOOK_COMMAND_MARKER = "deft hook:dispatch";
export const AGENT_HOOK_PATHS = [
  ".claude/settings.json",
  ".grok/hooks/deft.json",
  ".cursor/hooks.json",
] as const;

export type AgentHookPath = (typeof AGENT_HOOK_PATHS)[number];
export type AgentHookRegistrationStatus = "healthy" | "missing" | "drifted";

export interface AgentHookInspection {
  readonly host: HookHost;
  readonly path: AgentHookPath;
  readonly status: AgentHookRegistrationStatus;
  readonly detail: string;
}

export interface AgentHookDepositResult {
  readonly changed: boolean;
  readonly changedPaths: AgentHookPath[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function command(host: HookHost, event: "session.start" | "tool.before"): string {
  return `${DEFT_HOOK_COMMAND_MARKER} --host ${host} --event ${event}`;
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error(
      `${path} is not valid JSON; refusing to overwrite user configuration: ${cause}`,
    );
  }
  const config = object(parsed);
  if (config === null) {
    throw new Error(
      `${path} must contain a JSON object; refusing to overwrite user configuration.`,
    );
  }
  return config;
}

function hooksObject(config: Record<string, unknown>, path: string): Record<string, unknown> {
  if (config.hooks === undefined) return {};
  const hooks = object(config.hooks);
  if (hooks === null) throw new Error(`${path}: hooks must be a JSON object.`);
  return { ...hooks };
}

function eventArray(hooks: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = hooks[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: hooks.${key} must be an array.`);
  return [...value];
}

function nestedCommands(value: unknown): string[] {
  const group = object(value);
  if (group === null || !Array.isArray(group.hooks)) return [];
  return group.hooks.flatMap((candidate) => {
    const hook = object(candidate);
    return typeof hook?.command === "string" ? [hook.command] : [];
  });
}

function isManagedNestedGroup(value: unknown): boolean {
  return nestedCommands(value).some((value) => value.includes(DEFT_HOOK_COMMAND_MARKER));
}

function isManagedCursorEntry(value: unknown): boolean {
  const entry = object(value);
  return typeof entry?.command === "string" && entry.command.includes(DEFT_HOOK_COMMAND_MARKER);
}

function nestedGroup(host: "claude" | "grok", event: "session.start" | "tool.before") {
  return {
    ...(event === "tool.before" ? { matcher: DIRECT_WRITE_HOOK_MATCHER } : {}),
    hooks: [
      {
        type: "command",
        command: command(host, event),
        timeout: 5,
      },
    ],
  };
}

function mergeNestedConfig(
  config: Record<string, unknown>,
  path: string,
  host: "claude" | "grok",
): Record<string, unknown> {
  const hooks = hooksObject(config, path);
  const session = eventArray(hooks, "SessionStart", path).filter(
    (entry) => !isManagedNestedGroup(entry),
  );
  const preTool = eventArray(hooks, "PreToolUse", path).filter(
    (entry) => !isManagedNestedGroup(entry),
  );
  hooks.SessionStart = [...session, nestedGroup(host, "session.start")];
  hooks.PreToolUse = [...preTool, nestedGroup(host, "tool.before")];
  return { ...config, hooks };
}

function mergeCursorConfig(config: Record<string, unknown>, path: string): Record<string, unknown> {
  const hooks = hooksObject(config, path);
  const session = eventArray(hooks, "sessionStart", path).filter(
    (entry) => !isManagedCursorEntry(entry),
  );
  const preTool = eventArray(hooks, "preToolUse", path).filter(
    (entry) => !isManagedCursorEntry(entry),
  );
  hooks.sessionStart = [...session, { command: command("cursor", "session.start"), timeout: 5 }];
  hooks.preToolUse = [
    ...preTool,
    {
      command: command("cursor", "tool.before"),
      matcher: DIRECT_WRITE_HOOK_MATCHER,
      failClosed: true,
      timeout: 5,
    },
  ];
  return { ...config, version: 1, hooks };
}

function writeJsonIfChanged(path: string, payload: Record<string, unknown>): boolean {
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.deft-${process.pid}.tmp`;
  writeFileSync(temporary, next, "utf8");
  renameSync(temporary, path);
  return true;
}

/** Merge Directive-owned project hook entries without replacing user configuration. */
export function writeAgentHookDeposit(
  projectRoot: string,
  io: InitDepositIo = { printf: () => undefined },
): AgentHookDepositResult {
  const changedPaths: AgentHookPath[] = [];
  const definitions: Array<{
    path: AgentHookPath;
    merge: (config: Record<string, unknown>, path: string) => Record<string, unknown>;
  }> = [
    {
      path: AGENT_HOOK_PATHS[0],
      merge: (config, path) => mergeNestedConfig(config, path, "claude"),
    },
    {
      path: AGENT_HOOK_PATHS[1],
      merge: (config, path) => mergeNestedConfig(config, path, "grok"),
    },
    { path: AGENT_HOOK_PATHS[2], merge: mergeCursorConfig },
  ];

  const prepared = definitions.map((definition) => {
    const absolute = join(projectRoot, definition.path);
    assertDepositContained(projectRoot, absolute);
    const merged = definition.merge(readConfig(absolute), absolute);
    return { ...definition, absolute, merged };
  });

  for (const definition of prepared) {
    if (writeJsonIfChanged(definition.absolute, definition.merged)) {
      changedPaths.push(definition.path);
    }
  }
  if (changedPaths.length > 0) {
    io.printf(`Installed Directive agent hooks: ${changedPaths.join(", ")}\n`);
  } else {
    io.printf("Directive agent hooks already current.\n");
  }
  return { changed: changedPaths.length > 0, changedPaths };
}

function hasNestedRegistration(config: Record<string, unknown>, host: "claude" | "grok"): boolean {
  const hooks = object(config.hooks);
  if (hooks === null) return false;
  const session = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const preTool = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const sessionCommand = command(host, "session.start");
  const toolCommand = command(host, "tool.before");
  return (
    session.some((entry) => nestedCommands(entry).includes(sessionCommand)) &&
    preTool.some((entry) => {
      const group = object(entry);
      return (
        group?.matcher === DIRECT_WRITE_HOOK_MATCHER && nestedCommands(entry).includes(toolCommand)
      );
    })
  );
}

function hasCursorRegistration(config: Record<string, unknown>): boolean {
  const hooks = object(config.hooks);
  if (hooks === null || config.version !== 1) return false;
  const session = Array.isArray(hooks.sessionStart) ? hooks.sessionStart : [];
  const preTool = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  return (
    session.some((entry) => object(entry)?.command === command("cursor", "session.start")) &&
    preTool.some((entry) => {
      const hook = object(entry);
      return (
        hook?.command === command("cursor", "tool.before") &&
        hook.matcher === DIRECT_WRITE_HOOK_MATCHER &&
        hook.failClosed === true
      );
    })
  );
}

/** Read-only registration probe shared by verify and doctor. */
export function inspectAgentHookDeposit(projectRoot: string): AgentHookInspection[] {
  const definitions: Array<{
    host: HookHost;
    path: AgentHookPath;
    valid: (config: Record<string, unknown>) => boolean;
  }> = [
    {
      host: "claude",
      path: AGENT_HOOK_PATHS[0],
      valid: (config) => hasNestedRegistration(config, "claude"),
    },
    {
      host: "grok",
      path: AGENT_HOOK_PATHS[1],
      valid: (config) => hasNestedRegistration(config, "grok"),
    },
    { host: "cursor", path: AGENT_HOOK_PATHS[2], valid: hasCursorRegistration },
  ];

  return definitions.map((definition) => {
    const absolute = join(projectRoot, definition.path);
    if (!existsSync(absolute)) {
      return {
        host: definition.host,
        path: definition.path,
        status: "missing",
        detail: `${definition.path} is missing.`,
      };
    }
    try {
      const config = readConfig(absolute);
      if (definition.valid(config)) {
        return {
          host: definition.host,
          path: definition.path,
          status: "healthy",
          detail: "SessionStart and direct-write PreToolUse registrations are current.",
        };
      }
      return {
        host: definition.host,
        path: definition.path,
        status: "drifted",
        detail:
          "Directive SessionStart or direct-write PreToolUse registration is missing/drifted.",
      };
    } catch (cause) {
      return {
        host: definition.host,
        path: definition.path,
        status: "drifted",
        detail: String(cause),
      };
    }
  });
}
