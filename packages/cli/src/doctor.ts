#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdDoctor } from "@deftai/directive-core/dist/doctor/main.js";
import { renderPrecutoverLine } from "@deftai/directive-core/dist/vbrief-validate/precutover.js";

const PROJECT_ROOT_PREFIX = "--project-root=";

function resolveProjectRoot(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--project-root") {
      return argv[i + 1] ?? process.cwd();
    }
    if (token.startsWith(PROJECT_ROOT_PREFIX)) {
      const value = token.slice(PROJECT_ROOT_PREFIX.length);
      if (value) {
        return value;
      }
    }
  }
  return process.cwd();
}

export function run(argv: string[]): number {
  // #2022: surface pre-cutover (pre-v0.20 document model) migration state alongside the
  // core doctor report. The line is suppressed under --json so it does not corrupt the
  // machine-readable JSON document the core report emits.
  if (!argv.includes("--json")) {
    process.stdout.write(`${renderPrecutoverLine(resolveProjectRoot(argv))}\n`);
  }
  return cmdDoctor(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
