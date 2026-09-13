import { isHumanOrigin, isRejectedOriginKind } from "../authz/origin.js";
import { exactOriginSetEquals, formatOriginSet, uniqueOrigins } from "./origin-set.js";
import {
  MISSING_ONE_PR_UNIT_CONSENT,
  type OnePrUnitBinding,
  type OnePrUnitDecision,
  type OnePrUnitGrant,
  type OriginRef,
} from "./types.js";

export interface EvaluateOnePrUnitInput {
  readonly closerSet: readonly OriginRef[];
  readonly grant: OnePrUnitGrant | null;
  readonly binding?: OnePrUnitBinding;
}

function deny(code: OnePrUnitDecision["code"], message: string): OnePrUnitDecision {
  return { ok: false, code, message };
}

function allow(code: OnePrUnitDecision["code"], message: string): OnePrUnitDecision {
  return { ok: true, code, message };
}

function grantBound(grant: OnePrUnitGrant): boolean {
  return (grant.branch !== null && grant.branch.length > 0) || grant.prNumber !== null;
}

/**
 * One fail-closed decision: 0 or 1 distinct origin needs no grant; more than one
 * requires an operator-origin grant whose origin set equals the closer-set.
 * Independent of UAT mode. `--allow-close` and #1378 fields are not inputs.
 */
export function evaluateOnePrUnit(input: EvaluateOnePrUnitInput): OnePrUnitDecision {
  const closerSet = uniqueOrigins(input.closerSet);
  if (closerSet.length === 0) {
    return allow("allow-empty", "OK: closer-set is empty; one-PR-unit consent does not apply.");
  }
  if (closerSet.length === 1) {
    return allow(
      "allow-single-origin",
      `OK: single origin ${formatOriginSet(closerSet)}; one-PR-unit grant not required.`,
    );
  }

  const grant = input.grant;
  if (grant === null) {
    return deny(
      "deny-missing-consent",
      `${MISSING_ONE_PR_UNIT_CONSENT} (closer-set: ${formatOriginSet(closerSet)}).`,
    );
  }

  if (isRejectedOriginKind(grant.origin.kind) || !isHumanOrigin(grant.origin)) {
    return deny(
      "deny-origin-kind",
      `${MISSING_ONE_PR_UNIT_CONSENT} (grant ${grant.id} origin.kind=${grant.origin.kind} is not operator-origin).`,
    );
  }

  if (grant.revokedAt !== null) {
    return deny("deny-revoked", `one-PR-unit grant ${grant.id} was revoked at ${grant.revokedAt}.`);
  }
  if (grant.singleUse && grant.usedAt !== null) {
    return deny(
      "deny-spent",
      `one-PR-unit grant ${grant.id} is single-use and already spent at ${grant.usedAt}.`,
    );
  }

  if (!grantBound(grant) && !grant.singleUse) {
    return deny(
      "deny-unbound",
      `one-PR-unit grant ${grant.id} has no branch/PR-unit binding and is not single-use.`,
    );
  }

  const binding = input.binding ?? {};
  if (grant.branch !== null && grant.branch.length > 0) {
    if (
      binding.branch === null ||
      binding.branch === undefined ||
      binding.branch !== grant.branch
    ) {
      return deny(
        "deny-binding",
        `one-PR-unit grant ${grant.id} is bound to branch ${grant.branch}.`,
      );
    }
  }
  if (grant.prNumber !== null) {
    if (
      binding.prNumber === null ||
      binding.prNumber === undefined ||
      binding.prNumber !== grant.prNumber
    ) {
      return deny(
        "deny-binding",
        `one-PR-unit grant ${grant.id} is bound to PR #${grant.prNumber}.`,
      );
    }
  }
  if (grant.repo.length > 0 && binding.repo !== undefined && binding.repo !== null) {
    if (grant.repo.toLowerCase() !== binding.repo.toLowerCase()) {
      return deny("deny-binding", `one-PR-unit grant ${grant.id} is bound to repo ${grant.repo}.`);
    }
  }

  if (!exactOriginSetEquals(closerSet, grant.origins)) {
    return deny(
      "deny-origin-mismatch",
      `one-PR-unit grant ${grant.id} origin set ${formatOriginSet(grant.origins)} does not exactly match closer-set ${formatOriginSet(closerSet)}.`,
    );
  }

  return allow(
    "allow-granted",
    `OK: one-PR-unit grant ${grant.id} matches closer-set ${formatOriginSet(closerSet)}.`,
  );
}
