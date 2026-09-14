/**
 * Canonical one-PR-unit store: Directive GitHub App private transactional store.
 * Check-runs are a projection, not this store. Disk `.deft/one-pr-unit` is not SoT.
 */

import type { OnePrUnitClaim, OriginRef } from "./types.js";

export class UniqueMembershipError extends Error {
  readonly origin: OriginRef;
  constructor(origin: OriginRef) {
    super(`unique active membership conflict on ${origin.repo}#${origin.issueId}`);
    this.name = "UniqueMembershipError";
    this.origin = origin;
  }
}

export class OverlappingMintError extends Error {
  constructor() {
    super("overlapping concurrent one-PR-unit mints abort");
    this.name = "OverlappingMintError";
  }
}

export interface MintClaimInput {
  readonly actor: string;
  readonly approvalRef: string;
  readonly rationale: string;
  readonly origins: readonly OriginRef[];
  readonly repo: string;
  readonly now?: Date;
  /** Test seam only. Production mints an opaque id. */
  readonly id?: string;
}

export interface OnePrUnitAppStore {
  mint(input: MintClaimInput): OnePrUnitClaim;
  bind(id: string, prNodeId: string, now?: Date): OnePrUnitClaim;
  getById(id: string): OnePrUnitClaim | null;
  getByPrNodeId(prNodeId: string): OnePrUnitClaim | null;
  membershipOf(origin: OriginRef): OnePrUnitClaim | null;
  listActive(): OnePrUnitClaim[];
  consume(prNodeId: string, claimedSet: readonly OriginRef[], now?: Date): OnePrUnitClaim;
  revoke(id: string, actor: string, now?: Date): OnePrUnitClaim;
  revokeUnmerged(prNodeId: string, now?: Date): OnePrUnitClaim;
  expireDue(now?: Date): OnePrUnitClaim[];
}

/**
 * Envelope id is a lookup key into the App store, not a bearer.
 * After bind, only the bound PR node id authorizes.
 */
export function resolveClaimFromStore(
  store: OnePrUnitAppStore,
  input: { readonly id?: string | null; readonly prNodeId?: string | null },
): OnePrUnitClaim | null {
  const prNodeId = input.prNodeId?.trim() ?? "";
  if (prNodeId.length > 0) {
    return store.getByPrNodeId(prNodeId);
  }
  const id = input.id?.trim() ?? "";
  if (id.length === 0) return null;
  return store.getById(id);
}
