#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, evaluateAgentHooks } from "@deftai/directive-core/verify-env";

type HookScope = "git" | "agent" | "all";

interface ParsedArgs {
  projectRoot: string;
  quiet: boolean;
  scope: HookScope;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", quiet: false, scope: "git" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--scope") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --scope: expected one argument" };
      }
      if (value !== "git" && value !== "agent" && value !== "all") {
        return { ...parsed, error: `argument --scope: invalid choice: '${value}'` };
      }
      parsed.scope = value;
      i += 1;
    } else if (arg?.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (value !== "git" && value !== "agent" && value !== "all") {
        return { ...parsed, error: `argument --scope: invalid choice: '${value}'` };
      }
      parsed.scope = value;
    } else {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const results = [
    ...(args.scope === "git" || args.scope === "all" ? [evaluate(projectRoot)] : []),
    ...(args.scope === "agent" || args.scope === "all" ? [evaluateAgentHooks(projectRoot)] : []),
  ];
  if (!args.quiet) {
    for (const result of results) {
      if (result.stream === "stdout") {
        process.stdout.write(`${result.message}\n`);
      } else if (result.stream === "stderr") {
        process.stderr.write(`${result.message}\n`);
      }
    }
  }
  return Math.max(...results.map((result) => result.code));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
