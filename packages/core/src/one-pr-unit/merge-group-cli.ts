import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
/**
 * merge_group.checks_requested entry. Check-runs are a projection, not the store.
 * Live App + org ruleset app-restriction + merge queue enablement remain deploy gaps.
 */

import type { OnePrUnitAppStore } from "./app-store.js";
import {
  type ConstituentPrCensus,
  evaluateMergeGroupCheck,
  type MergeGroupCheckResult,
} from "./merge-group.js";
import { getDefaultAppStore } from "./simulator.js";

export interface MergeGroupEventLike {
  readonly action?: string;
  readonly merge_group?: {
    readonly head_sha?: string;
  };
}

export interface MergeGroupCliSeams {
  readonly store?: OnePrUnitAppStore;
  readonly loadConstituents?: (sha: string) => ConstituentPrCensus[];
}

export function loadMergeGroupEventFromPath(eventPath: string): MergeGroupEventLike {
  const raw = readFileSync(eventPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as MergeGroupEventLike;
}

export function runMergeGroupCheckFromEvent(
  event: MergeGroupEventLike,
  seams: MergeGroupCliSeams = {},
): MergeGroupCheckResult {
  const sha = event.merge_group?.head_sha?.trim() ?? "";
  if (sha.length === 0) {
    return {
      conclusion: "failure",
      title: "one-pr-unit",
      summary: "unreadable merge_group.head_sha",
      sha: "",
    };
  }
  const store = seams.store ?? getDefaultAppStore();
  const constituentPrs = seams.loadConstituents?.(sha) ?? [];
  return evaluateMergeGroupCheck({ mergeGroupSha: sha, constituentPrs, store });
}

export function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const eventPath = env.GITHUB_EVENT_PATH?.trim() ?? "";
  if (eventPath.length === 0) {
    process.stderr.write("one-pr-unit merge-group: GITHUB_EVENT_PATH is required\n");
    return 1;
  }
  let event: MergeGroupEventLike;
  try {
    event = loadMergeGroupEventFromPath(eventPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`one-pr-unit merge-group: failed to read event: ${message}\n`);
    return 1;
  }
  const result = runMergeGroupCheckFromEvent(event);
  process.stdout.write(`${result.conclusion} ${result.sha} ${result.title}\n${result.summary}\n`);
  return result.conclusion === "success" ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
