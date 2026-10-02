/**
 * Limb 4: criteria and scope authority (#4912).
 * Head-side xbrief/active weakening cannot produce a mergeable pass.
 */

import {
  type ApprovedCriteria,
  deny,
  type PrePrDecision,
  type PrePrExecutionRecord,
  sha256Hex,
} from "./types.js";

export interface CriteriaSource {
  readonly sourceRevisionSha: string;
  readonly scopePaths: readonly string[];
  readonly acceptanceText: string;
  readonly generation: number;
}

export function digestApprovedCriteria(source: CriteriaSource): ApprovedCriteria {
  const scopeDigest = sha256Hex(JSON.stringify([...source.scopePaths].sort()));
  const acceptanceDigest = sha256Hex(source.acceptanceText);
  const digest = sha256Hex(
    JSON.stringify({
      sourceRevisionSha: source.sourceRevisionSha,
      scopeDigest,
      acceptanceDigest,
    }),
  );
  return {
    digest,
    generation: source.generation,
    sourceRevisionSha: source.sourceRevisionSha,
    scopeDigest,
    acceptanceDigest,
  };
}

/** Amendment of approved criteria bumps evaluation generation. */
export function bumpGeneration(current: ApprovedCriteria, next: CriteriaSource): ApprovedCriteria {
  return digestApprovedCriteria({
    ...next,
    generation: current.generation + 1,
  });
}

export function isHeadSideWeakening(approved: ApprovedCriteria, head: ApprovedCriteria): boolean {
  if (head.sourceRevisionSha !== approved.sourceRevisionSha) return true;
  if (head.digest !== approved.digest) return true;
  if (head.scopeDigest !== approved.scopeDigest) return true;
  if (head.acceptanceDigest !== approved.acceptanceDigest) return true;
  return false;
}

export interface PublicationGateInput {
  readonly record: PrePrExecutionRecord;
  readonly currentGeneration: number;
  readonly approved: ApprovedCriteria;
  readonly headCriteria: ApprovedCriteria | null;
  /** ISO time of the newest invalidation. Older completions cannot publish over it. */
  readonly lastInvalidationAt: string | null;
}

export function evaluateCriteriaAuthority(input: PublicationGateInput): PrePrDecision {
  const { record, currentGeneration, approved, headCriteria, lastInvalidationAt } = input;
  if (headCriteria !== null && isHeadSideWeakening(approved, headCriteria)) {
    return deny(
      "deny-head-weakening",
      "head-side xbrief/active criteria or scope weakening cannot produce a mergeable pre-PR pass",
    );
  }
  if (record.evaluationGeneration !== currentGeneration) {
    return deny(
      "deny-generation-stale",
      `pre-PR record generation ${record.evaluationGeneration} is not current generation ${currentGeneration}`,
    );
  }
  if (record.criteria.digest !== approved.digest) {
    return deny(
      "deny-criteria-invalidated",
      "pre-PR record criteria digest does not match the approved source revision",
    );
  }
  if (
    lastInvalidationAt !== null &&
    record.completedAt !== null &&
    record.completedAt < lastInvalidationAt
  ) {
    return deny(
      "deny-out-of-order",
      "out-of-order older pre-PR completion cannot publish over a newer invalidation",
    );
  }
  return { ok: true, code: "allow-pass", message: "criteria authority holds" };
}
