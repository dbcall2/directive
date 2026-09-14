/**
 * Distinct one-PR-unit identity (#4494 bound recut). Not #1378 dispatch consent.
 * Opaque grant id is not a bearer credential.
 */

import type { GrantOrigin } from "../authz/types.js";

export const ONE_PR_UNIT_SCHEMA = "deft.one-pr-unit.v1" as const;

export const ONE_PR_UNIT_TTL_MS = 24 * 60 * 60 * 1000;

export const MISSING_ONE_PR_UNIT_CONSENT =
  "missing one-PR-unit consent — mint an operator-origin one-PR-unit grant for the exact origin set, or close one origin per PR";

export const SERIALIZE_N_PRS =
  'serialize N PRs (stacked or sequential solo-worker): one origin per PR. File overlap, missing swarm metadata, parallel_safe: false, swarm:readiness refusing concurrent workers, and "swarm if possible" are not one-PR-unit consent.';

export const SOLO_MULTI_COHORT_CONFIG =
  "config error: implement-class solo with |cohort_vbriefs| > 1 and no one-PR-unit grant. " +
  MISSING_ONE_PR_UNIT_CONSENT;

export const OPAQUE_ID_NOT_BEARER =
  "opaque one-PR-unit id is not a bearer credential; only the App store plus the bound PR node id authorizes";

export const DISK_STORE_NOT_SOT =
  "gitignored .deft/one-pr-unit disk store is not the verifier-visible record";

export type OnePrUnitState =
  | "reserved"
  | "bound"
  | "member-complete"
  | "spent"
  | "revoked"
  | "expired";

export interface OriginRef {
  readonly repo: string;
  readonly issueId: number;
}

/** Canonical App-store claim. `id` is a lookup key, not a bearer. */
export interface OnePrUnitClaim {
  readonly schema: typeof ONE_PR_UNIT_SCHEMA;
  readonly id: string;
  readonly origin: GrantOrigin;
  readonly approvalRef: string;
  readonly rationale: string;
  readonly origins: readonly OriginRef[];
  readonly repo: string;
  readonly state: OnePrUnitState;
  /** GitHub PR node id after irreversible bind; null while reserved. */
  readonly prNodeId: string | null;
  readonly mintedBy: string;
  readonly mintedAt: string;
  readonly expiresAt: string;
  readonly boundAt: string | null;
  readonly spentAt: string | null;
  readonly revokedAt: string | null;
  readonly expiredAt: string | null;
}

/** Same record as OnePrUnitClaim (historical name). */
export type OnePrUnitGrant = OnePrUnitClaim;

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
  | "deny-revoked"
  | "deny-expired"
  | "deny-not-bearer"
  | "deny-unreadable"
  | "deny-extra-declaration";

export interface OnePrUnitDecision {
  readonly ok: boolean;
  readonly code: OnePrUnitDecisionCode;
  readonly message: string;
}

export interface OnePrUnitBinding {
  readonly repo?: string | null;
  /** GitHub PR node id. PR number is not the bind term. */
  readonly prNodeId?: string | null;
}
