import { isHumanOrigin, isRejectedOriginKind } from "../authz/origin.js";
import { exactOriginSetEquals, formatOriginSet, uniqueOrigins } from "./origin-set.js";
import {
  MISSING_ONE_PR_UNIT_CONSENT,
  type OnePrUnitBinding,
  type OnePrUnitClaim,
  type OnePrUnitDecision,
  OPAQUE_ID_NOT_BEARER,
  type OriginRef,
} from "./types.js";

export interface EvaluateOnePrUnitInput {
  readonly closerSet: readonly OriginRef[];
  /** Claim resolved from the App store. Null means no store hit. */
  readonly grant: OnePrUnitClaim | null;
  readonly binding?: OnePrUnitBinding;
  /** Envelope opaque id presented without a store hit. */
  readonly presentedIdWithoutStore?: boolean;
}

function deny(code: OnePrUnitDecision["code"], message: string): OnePrUnitDecision {
  return { ok: false, code, message };
}

function allow(code: OnePrUnitDecision["code"], message: string): OnePrUnitDecision {
  return { ok: true, code, message };
}

/**
 * One fail-closed decision: 0 or 1 distinct origin needs no grant; more than one
 * requires an App-store claim whose origin set equals the closer-set.
 * `--allow-close` and #1378 fields are not inputs.
 * Opaque id is not a bearer: a presented id without a store claim is deny-not-bearer.
 */
export function evaluateOnePrUnit(input: EvaluateOnePrUnitInput): OnePrUnitDecision {
  const closerSet = uniqueOrigins(input.closerSet);
  if (input.presentedIdWithoutStore === true && input.grant === null && closerSet.length > 1) {
    return deny(
      "deny-not-bearer",
      `${OPAQUE_ID_NOT_BEARER} (closer-set: ${formatOriginSet(closerSet)}).`,
    );
  }
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

  if (grant.state === "revoked" || grant.revokedAt !== null) {
    return deny("deny-revoked", `one-PR-unit grant ${grant.id} was revoked at ${grant.revokedAt}.`);
  }
  if (grant.state === "expired" || grant.expiredAt !== null) {
    return deny("deny-expired", `one-PR-unit grant ${grant.id} expired at ${grant.expiresAt}.`);
  }
  if (grant.state === "spent" || grant.spentAt !== null) {
    return deny("deny-spent", `one-PR-unit grant ${grant.id} is spent at ${grant.spentAt}.`);
  }

  const binding = input.binding ?? {};
  if (grant.state === "reserved" && grant.prNodeId === null) {
    const presented = binding.prNodeId?.trim() ?? "";
    if (presented.length > 0) {
      return deny(
        "deny-unbound",
        `one-PR-unit grant ${grant.id} is reserved and unbound; first App interaction must bind this PR node id`,
      );
    }
  }
  if (grant.prNodeId !== null) {
    const presented = binding.prNodeId?.trim() ?? "";
    if (presented.length === 0) {
      return deny("deny-not-bearer", `${OPAQUE_ID_NOT_BEARER} (grant ${grant.id} is bound).`);
    }
    if (presented !== grant.prNodeId) {
      return deny(
        "deny-binding",
        `one-PR-unit grant ${grant.id} is bound to a different GitHub PR node id.`,
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
