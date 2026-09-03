/** Node/package-manager presence contract for TS-backed consumer gates. */

import type { PackageManager } from "../resolution/package-manager.js";

/** All supported Node/package-manager tool names across consumer projects. */
export const NODE_RUNTIME_TOOL_NAMES = ["node", "npm", "pnpm"] as const;

export const NODE_RUNTIME_REMEDIATION =
  "Node.js and pnpm are required for TS-backed deft gates. Install Node 20+, then run: corepack enable && corepack prepare pnpm@latest --activate. See UPGRADING.md § Node runtime.";

/** npm ships with the supported Node distribution; Corepack/pnpm is not required. */
export const NPM_RUNTIME_REMEDIATION =
  "Node.js and npm are required for TS-backed deft gates. Install or repair Node 20+ (npm is bundled), then re-run the consumer check. See UPGRADING.md § Node runtime.";

/** Append remediation lines for node or the package manager selected by the project. */
export function nodeRuntimeRemediationLines(
  failed: readonly string[],
  packageManager: PackageManager = "pnpm",
): readonly string[] {
  if (failed.includes("node") || failed.includes(packageManager)) {
    return [packageManager === "npm" ? NPM_RUNTIME_REMEDIATION : NODE_RUNTIME_REMEDIATION];
  }
  return [];
}
