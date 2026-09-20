/**
 * Local terminal-folder scan for ordered-plan drift (#4129).
 *
 * Reuses TIP_TERMINAL_FOLDERS, collectGithubRefs, and hasTransitionWrite.
 * Dual-root xbrief/ + legacy vbrief/. No GitHub issue-state client.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
  resolveLifecycleRoot,
} from "../layout/resolve.js";
import { collectGithubRefs } from "../orphan-active/refs.js";
import { hasTransitionWrite } from "../scope/lifecycle-write.js";
import type { TerminalLifecycleOrigin } from "./terminal-drift.js";

/** Same members as `TIP_TERMINAL_FOLDERS` — local to avoid loading the GitHub land gate. */
export const TERMINAL_LIFECYCLE_FOLDERS = ["completed", "cancelled"] as const;

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/u;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const plan = data?.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

function relPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function storyIdsFromName(name: string): string[] {
  let stem = name;
  if (stem.endsWith(".xbrief.json")) {
    stem = stem.slice(0, -".xbrief.json".length);
  } else if (stem.endsWith(".vbrief.json")) {
    stem = stem.slice(0, -".vbrief.json".length);
  }
  const ids = [stem];
  const stripped = stem.replace(DATE_PREFIX_RE, "");
  if (stripped.length > 0 && stripped !== stem) {
    ids.push(stripped);
  }
  return ids;
}

function lifecycleRoots(projectRoot: string): string[] {
  const roots: string[] = [];
  try {
    roots.push(resolveLifecycleRoot(projectRoot));
  } catch {
    // no xbrief layout
  }
  const legacyRoot = join(projectRoot, LEGACY_ARTIFACT_DIR);
  if (existsSync(legacyRoot) && !roots.includes(legacyRoot)) {
    roots.push(legacyRoot);
  }
  const migrated = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  if (existsSync(migrated) && !roots.includes(migrated)) {
    roots.push(migrated);
  }
  return roots;
}

/**
 * Scan local completed/cancelled ledgers (xbrief + vbrief) into pure drift facts.
 */
export function collectTerminalLifecycleOrigins(
  projectRoot: string,
  options?: { readonly defaultRepo?: string | null },
): TerminalLifecycleOrigin[] {
  const defaultRepo = options?.defaultRepo ?? "_";
  const out: TerminalLifecycleOrigin[] = [];
  for (const root of lifecycleRoots(projectRoot)) {
    for (const folder of TERMINAL_LIFECYCLE_FOLDERS) {
      const dir = join(root, folder);
      if (!existsSync(dir)) {
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!hasArtifactSuffix(name)) {
          continue;
        }
        const path = join(dir, name);
        const plan = planOf(readJson(path));
        if (plan === null) {
          continue;
        }
        const refs = collectGithubRefs(plan, defaultRepo);
        const storyIds = storyIdsFromName(name);
        if (typeof plan.id === "string" && plan.id.trim().length > 0) {
          storyIds.push(plan.id.trim());
        }
        const title = typeof plan.title === "string" ? plan.title : undefined;
        const failed = String(plan.status ?? "") === "failed";
        out.push({
          path: relPath(path, projectRoot),
          folder,
          issueNumbers: refs.issues.map((issue) => issue.number),
          prNumbers: refs.prs.map((pr) => pr.number),
          storyIds,
          title,
          failed,
          hasTransitionWrite: hasTransitionWrite(plan) || failed,
        });
      }
    }
  }
  return out;
}
