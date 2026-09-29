/**
 * Shared reviewer-presence determination (#3630).
 *
 * Named non-CLEAN weather terminal for "no bot reviewer installed", inherited
 * by pr:watch / pr:merge-ready. Reuses isBotReviewCheck (no second detector).
 *
 * Policy (#3452):
 * - Assumptions: bot check-runs are excluded from CI readiness; the first
 *   HEAD check-run fetch can be empty/partial before an installed bot posts.
 * - Guarantees: empty observation never CLEANs; ambiguity fail-closes to
 *   poll (`expected`); explicit `reviewers: []` is the named zero; slow
 *   reviewers (comment / bot check / local config / non-empty policy) poll.
 * - Non-goals: #769 substitution; treating green non-bot CI as proof that
 *   no reviewer is installed; GitHub App installation enumeration.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isBotReviewCheck } from "./ci-gate.js";

/** Canonical parent handback when the wait exits for zero reviewers. */
export const REVIEW_CYCLE_NO_REVIEWER_HANDBACK = "review_cycle: skipped:no-reviewer-installed";

export const REVIEWER_STATE_EXPECTED = "expected";
export const REVIEWER_STATE_NO_REVIEWER_INSTALLED = "no_reviewer_installed";

export type ReviewerReadyState =
  | typeof REVIEWER_STATE_EXPECTED
  | typeof REVIEWER_STATE_NO_REVIEWER_INSTALLED;

export type ReviewerExpectationSource = "policy" | "comment" | "check_run" | "config" | "probe";

export interface ReviewerExpectation {
  readonly state: ReviewerReadyState;
  readonly source: ReviewerExpectationSource;
  readonly handback: string | null;
}

export interface ReviewerExpectationInput {
  /** Explicit plan.policy.review.reviewers; null means unset (probe). */
  readonly policyReviewers: readonly string[] | null;
  readonly reviewCommentPresent: boolean;
  readonly botReviewCheckPresent: boolean;
  readonly reviewerConfigPresent: boolean;
  /**
   * True when HEAD check-runs could not be fetched. Ambiguity fail-closes to
   * poll (expected), never CLEAN / never no-reviewer.
   */
  readonly checkRunsUnknown?: boolean;
  /**
   * evaluateCiGate ready_state. In-flight CI (`not_ready_yet` /
   * `runner_capacity_stall`) fail-closes to poll so a slow bot check-run can
   * still appear. Green non-bot CI is not absence (bot checks are excluded).
   */
  readonly ciReadyState?: string | null;
  /**
   * Caller has a complete HEAD check-run inventory AND a local doctor/config
   * scan that can honestly assert no reviewer is installed. CI-ready (non-bot)
   * alone must not set this — a late installed bot can still appear.
   */
  readonly absenceInventoryComplete?: boolean;
}

export const MERGE_READY_NO_REVIEWER_FAILURE =
  "No bot reviewer installed (NO_REVIEWER_INSTALLED). " +
  "Named non-CLEAN terminal (#3630), not review pending. " +
  "Route to deft-directive-pre-pr self-review. " +
  `Handback: ${REVIEW_CYCLE_NO_REVIEWER_HANDBACK}. ` +
  "#769 substitution registry does not cover empty registry.";

const CI_IN_FLIGHT = new Set(["not_ready_yet", "runner_capacity_stall"]);

function expected(source: ReviewerExpectationSource): ReviewerExpectation {
  return { state: REVIEWER_STATE_EXPECTED, source, handback: null };
}

function absent(source: ReviewerExpectationSource): ReviewerExpectation {
  return {
    state: REVIEWER_STATE_NO_REVIEWER_INSTALLED,
    source,
    handback: REVIEW_CYCLE_NO_REVIEWER_HANDBACK,
  };
}

/**
 * Once-before-loop presence determination (#3630).
 *
 * Policy empty list is an explicit zero. Policy non-empty is expected (slow
 * path). Current-HEAD comment / bot check-run / local config are positive
 * evidence. Unreachable check-runs, in-flight CI, young/empty inventory, and
 * completed non-bot CI fail-close to poll. Probe absence fires only when the
 * caller asserts `absenceInventoryComplete` — never CLEAN.
 */
export function evaluateReviewerExpectation(input: ReviewerExpectationInput): ReviewerExpectation {
  if (input.policyReviewers !== null) {
    if (input.policyReviewers.length === 0) {
      return absent("policy");
    }
    return expected("policy");
  }
  if (input.reviewCommentPresent) {
    return expected("comment");
  }
  if (input.botReviewCheckPresent) {
    return expected("check_run");
  }
  if (input.reviewerConfigPresent) {
    return expected("config");
  }
  if (input.checkRunsUnknown === true) {
    return expected("probe");
  }
  const ci = input.ciReadyState ?? null;
  if (ci !== null && CI_IN_FLIGHT.has(ci)) {
    return expected("probe");
  }
  if (input.absenceInventoryComplete === true) {
    return absent("probe");
  }
  return expected("probe");
}

export function botReviewCheckPresent(checkRuns: readonly { readonly name: string }[]): boolean {
  return checkRuns.some((run) => isBotReviewCheck(run.name));
}

export const REVIEWER_CONFIG_BASENAMES = ["greptile.json", ".greptile/config.json"] as const;

export function reviewerConfigPresent(
  projectRoot: string | null | undefined,
  isFile: (path: string) => boolean = existsSync,
): boolean {
  if (projectRoot === null || projectRoot === undefined || projectRoot.length === 0) {
    return false;
  }
  return REVIEWER_CONFIG_BASENAMES.some((rel) => isFile(join(projectRoot, rel)));
}
