/**
 * Distinct one-PR-unit identity (#4494). Not #1378 dispatch consent.
 */

import type { GrantOrigin } from "../authz/types.js";

export const ONE_PR_UNIT_SCHEMA = "deft.one-pr-unit.v1" as const;

export const MISSING_ONE_PR_UNIT_CONSENT =
  "missing one-PR-unit consent — mint an operator-origin one-PR-unit grant for the exact origin set, or close one origin per PR";

export const SERIALIZE_N_PRS =
  'serialize N PRs (stacked or sequential solo-worker): one origin per PR. File overlap, missing swarm metadata, parallel_safe: false, swarm:readiness refusing concurrent workers, and "swarm if possible" are not one-PR-unit consent.';

export const SOLO_MULTI_COHORT_CONFIG =
  "config error: implement-class solo with |cohort_vbriefs| > 1 and no one-PR-unit grant. " +
  MISSING_ONE_PR_UNIT_CONSENT;

export interface OriginRef {
  readonly repo: string;
  readonly issueId: number;
}

export interface OnePrUnitGrant {
  readonly schema: typeof ONE_PR_UNIT_SCHEMA;
  readonly id: string;
  readonly origin: GrantOrigin;
  readonly approvalRef: string;
  readonly rationale: string;
  readonly origins: readonly OriginRef[];
  readonly repo: string;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly singleUse: boolean;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
  readonly mintedAt: string;
}

export type OnePrUnitDecisionCode =
  | "allow-empty"
  | "allow-single-origin"
  | "allow-granted"
  | "deny-missing-consent"
  | "deny-origin-kind"
  | "deny-origin-mismatch"
  | "deny-binding"
  | "deny-unbound"
  | "deny-spent"
  | "deny-revoked";

export interface OnePrUnitDecision {
  readonly ok: boolean;
  readonly code: OnePrUnitDecisionCode;
  readonly message: string;
}

export interface OnePrUnitBinding {
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly prNumber?: number | null;
}
