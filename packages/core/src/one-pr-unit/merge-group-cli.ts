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
