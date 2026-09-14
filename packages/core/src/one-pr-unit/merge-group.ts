/**
 * Merge-queue App check on `merge_group.checks_requested` (#4494).
 * Literal "dequeue" is not an event name. Check-runs are a projection, not the store.
 */

import type { OnePrUnitAppStore } from "./app-store.js";
import { closerSetFromReferences } from "./closer-set.js";
import { evaluateOnePrUnit } from "./evaluate.js";
import { exactOriginSetEquals, formatOriginSet, uniqueOrigins } from "./origin-set.js";
import type { OriginRef } from "./types.js";

export const MERGE_GROUP_EVENT = "merge_group.checks_requested" as const;
export const MERGE_GROUP_CHECK_NAME = "one-pr-unit";

export interface ConstituentPrCensus {
  readonly prNodeId: string;
  readonly repo: string;
  /** Live forge closingIssuesReferences. null = unreadable. */
  readonly closingIssuesReferences: readonly number[] | null;
  readonly body: string | null;
  readonly commitMessages: readonly string[] | null;
}

export interface MergeGroupCheckInput {
  readonly mergeGroupSha: string;
  readonly constituentPrs: readonly ConstituentPrCensus[];
  readonly store: OnePrUnitAppStore;
}

export interface MergeGroupCheckResult {
  readonly conclusion: "success" | "failure";
  readonly title: string;
  readonly summary: string;
  readonly sha: string;
}

function censusOf(pr: ConstituentPrCensus): {
  readonly origins: OriginRef[];
  readonly unreadable: boolean;
} {
  const texts =
    pr.body === null || pr.commitMessages === null ? null : [pr.body, ...pr.commitMessages];
  return closerSetFromReferences(pr.repo, pr.closingIssuesReferences, texts);
}

/**
 * Compare each constituent PR's live closer census to its bound reservation.
 * Single-origin / no-grant PRs still get a passing App check.
 */
export function evaluateMergeGroupCheck(input: MergeGroupCheckInput): MergeGroupCheckResult {
  if (input.constituentPrs.length === 0) {
    return {
      conclusion: "failure",
      title: MERGE_GROUP_CHECK_NAME,
      summary: "missing constituent PR on merge_group.checks_requested",
      sha: input.mergeGroupSha,
    };
  }
  const notes: string[] = [];
  for (const pr of input.constituentPrs) {
    if (pr.prNodeId.trim().length === 0) {
      return {
        conclusion: "failure",
        title: MERGE_GROUP_CHECK_NAME,
        summary: "unreadable PR node id on merge_group constituent",
        sha: input.mergeGroupSha,
      };
    }
    const census = censusOf(pr);
    if (census.unreadable) {
      return {
        conclusion: "failure",
        title: MERGE_GROUP_CHECK_NAME,
        summary: `unreadable closer source for PR node ${pr.prNodeId} (closingIssuesReferences, body, or commit messages)`,
        sha: input.mergeGroupSha,
      };
    }
    const claim = input.store.getByPrNodeId(pr.prNodeId);
    if (census.origins.length <= 1 && claim === null) {
      notes.push(`single-origin/no-grant PR ${pr.prNodeId}: passing`);
      continue;
    }
    if (claim === null) {
      const decision = evaluateOnePrUnit({ closerSet: census.origins, grant: null });
      return {
        conclusion: "failure",
        title: MERGE_GROUP_CHECK_NAME,
        summary: `unbound claim: ${decision.message}`,
        sha: input.mergeGroupSha,
      };
    }
    const reserved = uniqueOrigins(claim.origins);
    const extra = census.origins.filter(
      (item) => !reserved.some((r) => r.repo === item.repo && r.issueId === item.issueId),
    );
    if (extra.length > 0) {
      return {
        conclusion: "failure",
        title: MERGE_GROUP_CHECK_NAME,
        summary: `extra declaration ${formatOriginSet(extra)} is not a remaining claimed member of ${claim.id}`,
        sha: input.mergeGroupSha,
      };
    }
    const decision = evaluateOnePrUnit({
      closerSet: census.origins,
      grant: claim,
      binding: { repo: pr.repo, prNodeId: pr.prNodeId },
    });
    if (!decision.ok) {
      return {
        conclusion: "failure",
        title: MERGE_GROUP_CHECK_NAME,
        summary: decision.message,
        sha: input.mergeGroupSha,
      };
    }
    if (
      !exactOriginSetEquals(census.origins, claim.origins) &&
      census.origins.length !== claim.origins.length
    ) {
      // Remaining claimed members may still close through the App after consume.
      notes.push(`PR ${pr.prNodeId}: remaining claimed members ${formatOriginSet(claim.origins)}`);
    } else {
      notes.push(decision.message);
    }
  }
  return {
    conclusion: "success",
    title: MERGE_GROUP_CHECK_NAME,
    summary: notes.join("; ") || "OK: merge_group one-PR-unit check",
    sha: input.mergeGroupSha,
  };
}

export function isMergeGroupChecksRequested(eventName: string, action?: string | null): boolean {
  if (eventName === MERGE_GROUP_EVENT) return true;
  return eventName === "merge_group" && action === "checks_requested";
}
