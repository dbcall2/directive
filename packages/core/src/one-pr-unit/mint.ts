import { isHumanOrigin, isRejectedOriginKind } from "../authz/origin.js";
import type { GrantOrigin } from "../authz/types.js";
import { uniqueOrigins } from "./origin-set.js";
import { utcIso, writeOnePrUnitGrant } from "./store.js";
import { ONE_PR_UNIT_SCHEMA, type OnePrUnitGrant, type OriginRef } from "./types.js";

export interface MintOnePrUnitInput {
  readonly projectRoot: string;
  readonly id: string;
  readonly actor: string;
  readonly approvalRef: string;
  readonly rationale: string;
  readonly origins: readonly OriginRef[];
  readonly repo: string;
  readonly branch?: string | null;
  readonly prNumber?: number | null;
  readonly singleUse?: boolean;
  readonly now?: Date;
}

export function mintOnePrUnitGrant(input: MintOnePrUnitInput): OnePrUnitGrant {
  const mintedAt = utcIso(input.now);
  const origin: GrantOrigin = {
    kind: "operator-cli",
    actor: input.actor,
    mintedAt,
    mintedVia: "one-pr-unit:mint",
    eventRef: input.approvalRef,
  };
  if (isRejectedOriginKind(origin.kind) || !isHumanOrigin(origin)) {
    throw new Error(
      "one-pr-unit mint requires operator-cli origin; agent-authored allocation strings do not count",
    );
  }
  const origins = uniqueOrigins(input.origins);
  if (origins.length < 2) {
    throw new Error("one-pr-unit mint requires at least two origins");
  }
  const branch = input.branch ?? null;
  const prNumber = input.prNumber ?? null;
  const singleUse = input.singleUse === true;
  if ((branch === null || branch.length === 0) && prNumber === null && !singleUse) {
    throw new Error("one-pr-unit mint requires branch/PR-unit binding or single-use");
  }
  const grant: OnePrUnitGrant = {
    schema: ONE_PR_UNIT_SCHEMA,
    id: input.id.trim(),
    origin,
    approvalRef: input.approvalRef.trim(),
    rationale: input.rationale.trim(),
    origins,
    repo: input.repo.trim(),
    branch,
    prNumber,
    singleUse,
    usedAt: null,
    revokedAt: null,
    mintedAt,
  };
  if (grant.id.length === 0 || grant.approvalRef.length === 0 || grant.rationale.length === 0) {
    throw new Error("one-pr-unit mint requires id, approvalRef, and rationale");
  }
  writeOnePrUnitGrant(input.projectRoot, grant);
  return grant;
}
