/**
 * Detect writes aimed at the Cursor planning-choice store (#4973 clause 5).
 */

import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { platformUserConfigDir } from "../../user-config/resolve-user-md.js";
import { CURSOR_PLAN_CHOICE_REL_SEGMENTS } from "./types.js";

export function cursorPlanChoiceStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  return resolve(platformUserConfigDir(platform, env, homeDir), ...CURSOR_PLAN_CHOICE_REL_SEGMENTS);
}

export function isCursorPlanChoiceManagedPath(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): boolean {
  const root = cursorPlanChoiceStoreRoot(env, platform, homeDir);
  const abs = resolve(target);
  const rel = relative(root, abs);
  if (rel === "") return true;
  if (rel.startsWith(`..${sep}`) || rel === "..") return false;
  if (platform === "win32" && /^[A-Za-z]:[\\/]/.test(rel)) return false;
  return !rel.startsWith("..");
}
