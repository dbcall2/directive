/**
 * In-process App simulator with unique active membership (#4494).
 * Remaining deploy: live Directive GitHub App + org ruleset app-restriction.
 */

import { randomBytes } from "node:crypto";
import { isHumanOrigin } from "../authz/origin.js";
import type { GrantOrigin } from "../authz/types.js";
import {
  type MintClaimInput,
  type OnePrUnitAppStore,
  OverlappingMintError,
  UniqueMembershipError,
} from "./app-store.js";
import { originKey, uniqueOrigins } from "./origin-set.js";
import {
  ONE_PR_UNIT_SCHEMA,
  ONE_PR_UNIT_TTL_MS,
  type OnePrUnitClaim,
  type OriginRef,
} from "./types.js";

export function utcIso(now?: Date): string {
  const dt = now ?? new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function activeMembership(state: OnePrUnitClaim["state"]): boolean {
  return state === "reserved" || state === "bound" || state === "member-complete";
}

export class InProcessAppStore implements OnePrUnitAppStore {
  private readonly claims = new Map<string, OnePrUnitClaim>();
  private readonly membership = new Map<string, string>();
  private readonly byPrNode = new Map<string, string>();
  private minting = false;
  /** Test seam: run before membership is reserved. */
  onBeforeReserve: (() => void) | null = null;

  mint(input: MintClaimInput): OnePrUnitClaim {
    if (this.minting) {
      throw new OverlappingMintError();
    }
    this.minting = true;
    try {
      if (this.onBeforeReserve !== null) {
        this.onBeforeReserve();
      }
      const origins = uniqueOrigins(input.origins);
      if (origins.length < 2) {
        throw new Error("one-pr-unit mint requires at least two origins");
      }
      const actor = input.actor.trim();
      const approvalRef = input.approvalRef.trim();
      const rationale = input.rationale.trim();
      const repo = input.repo.trim();
      if (
        actor.length === 0 ||
        approvalRef.length === 0 ||
        rationale.length === 0 ||
        repo.length === 0
      ) {
        throw new Error("one-pr-unit mint requires actor, approvalRef, rationale, and repo");
      }
      const now = input.now ?? new Date();
      const mintedAt = utcIso(now);
      const origin: GrantOrigin = {
        kind: "operator-cli",
        actor,
        mintedAt,
        mintedVia: "authz:grant/one-pr-unit",
        eventRef: approvalRef,
      };
      if (!isHumanOrigin(origin)) {
        throw new Error(
          "one-pr-unit mint requires operator-cli origin; agent-authored allocation strings do not count",
        );
      }
      for (const item of origins) {
        const existingId = this.membership.get(originKey(item));
        if (existingId !== undefined) {
          const existing = this.claims.get(existingId);
          if (existing !== undefined && activeMembership(existing.state)) {
            throw new UniqueMembershipError(item);
          }
        }
      }
      const id = (input.id?.trim() || `opu_${randomBytes(8).toString("hex")}`).trim();
      if (this.claims.has(id)) {
        throw new OverlappingMintError();
      }
      const claim: OnePrUnitClaim = {
        schema: ONE_PR_UNIT_SCHEMA,
        id,
        origin,
        approvalRef,
        rationale,
        origins,
        repo,
        state: "reserved",
        prNodeId: null,
        mintedBy: actor,
        mintedAt,
        expiresAt: utcIso(new Date(now.getTime() + ONE_PR_UNIT_TTL_MS)),
        boundAt: null,
        spentAt: null,
        revokedAt: null,
        expiredAt: null,
      };
      this.claims.set(id, claim);
      for (const item of origins) {
        this.membership.set(originKey(item), id);
      }
      return claim;
    } finally {
      this.minting = false;
    }
  }

  bind(id: string, prNodeId: string, now?: Date): OnePrUnitClaim {
    const claim = this.require(id);
    this.expireIfDue(claim, now);
    const node = prNodeId.trim();
    if (node.length === 0) {
      throw new Error("bind requires a GitHub PR node id");
    }
    const current = this.claims.get(id);
    if (current === undefined) {
      throw new Error(`one-PR-unit claim ${id} not found`);
    }
    if (current.state === "expired" || current.state === "revoked" || current.state === "spent") {
      throw new Error(`one-PR-unit claim ${id} is ${current.state}`);
    }
    if (current.prNodeId !== null && current.prNodeId !== node) {
      throw new Error(`one-PR-unit claim ${id} is already bound to a different PR node id`);
    }
    if (current.prNodeId === node) {
      return current;
    }
    const bound: OnePrUnitClaim = {
      ...current,
      state: "bound",
      prNodeId: node,
      boundAt: utcIso(now),
    };
    this.claims.set(id, bound);
    this.byPrNode.set(node, id);
    return bound;
  }

  getById(id: string): OnePrUnitClaim | null {
    const claim = this.claims.get(id) ?? null;
    if (claim === null) return null;
    return this.expireIfDue(claim);
  }

  getByPrNodeId(prNodeId: string): OnePrUnitClaim | null {
    const id = this.byPrNode.get(prNodeId.trim());
    if (id === undefined) return null;
    return this.getById(id);
  }

  membershipOf(origin: OriginRef): OnePrUnitClaim | null {
    const id = this.membership.get(originKey(origin));
    if (id === undefined) return null;
    const claim = this.getById(id);
    if (claim === null || !activeMembership(claim.state)) return null;
    return claim;
  }

  listActive(): OnePrUnitClaim[] {
    const out: OnePrUnitClaim[] = [];
    for (const claim of this.claims.values()) {
      const next = this.expireIfDue(claim);
      if (activeMembership(next.state)) out.push(next);
    }
    return out;
  }

  consume(prNodeId: string, claimedSet: readonly OriginRef[], now?: Date): OnePrUnitClaim {
    const claim = this.getByPrNodeId(prNodeId);
    if (claim === null) {
      throw new Error("consume requires a bound one-PR-unit claim for this PR node id");
    }
    if (claim.state !== "bound" && claim.state !== "member-complete") {
      throw new Error(`one-PR-unit claim ${claim.id} cannot be consumed in state ${claim.state}`);
    }
    const claimed = uniqueOrigins(claimedSet);
    const remaining = uniqueOrigins(claim.origins).filter(
      (item) => !claimed.some((c) => originKey(c) === originKey(item)),
    );
    if (claimed.length === 0) {
      throw new Error("consume requires a claimed origin set");
    }
    for (const item of claimed) {
      this.membership.delete(originKey(item));
    }
    const next: OnePrUnitClaim =
      remaining.length === 0
        ? {
            ...claim,
            state: "spent",
            spentAt: utcIso(now),
          }
        : {
            ...claim,
            state: "member-complete",
            origins: remaining,
          };
    this.claims.set(claim.id, next);
    if (next.state === "spent" && next.prNodeId !== null) {
      this.byPrNode.delete(next.prNodeId);
    }
    return next;
  }

  revoke(id: string, actor: string, now?: Date): OnePrUnitClaim {
    const claim = this.require(id);
    if (actor.trim() !== claim.mintedBy) {
      throw new Error(`only the minting operator ${claim.mintedBy} may revoke claim ${id}`);
    }
    return this.markRevoked(claim, now);
  }

  revokeUnmerged(prNodeId: string, now?: Date): OnePrUnitClaim {
    const claim = this.getByPrNodeId(prNodeId);
    if (claim === null) {
      throw new Error("no bound one-PR-unit claim for this PR node id");
    }
    return this.markRevoked(claim, now);
  }

  expireDue(now?: Date): OnePrUnitClaim[] {
    const expired: OnePrUnitClaim[] = [];
    for (const claim of [...this.claims.values()]) {
      const next = this.expireIfDue(claim, now);
      if (next.state === "expired") expired.push(next);
    }
    return expired;
  }

  private require(id: string): OnePrUnitClaim {
    const claim = this.claims.get(id);
    if (claim === undefined) {
      throw new Error(`one-PR-unit claim ${id} not found`);
    }
    return claim;
  }

  private expireIfDue(claim: OnePrUnitClaim, now?: Date): OnePrUnitClaim {
    if (!activeMembership(claim.state)) return claim;
    const nowMs = (now ?? new Date()).getTime();
    if (nowMs <= Date.parse(claim.expiresAt)) return claim;
    const expired: OnePrUnitClaim = {
      ...claim,
      state: "expired",
      expiredAt: utcIso(now),
    };
    this.claims.set(claim.id, expired);
    for (const item of claim.origins) {
      if (this.membership.get(originKey(item)) === claim.id) {
        this.membership.delete(originKey(item));
      }
    }
    if (claim.prNodeId !== null) this.byPrNode.delete(claim.prNodeId);
    return expired;
  }

  private markRevoked(claim: OnePrUnitClaim, now?: Date): OnePrUnitClaim {
    const revoked: OnePrUnitClaim = {
      ...claim,
      state: "revoked",
      revokedAt: utcIso(now),
    };
    this.claims.set(claim.id, revoked);
    for (const item of claim.origins) {
      if (this.membership.get(originKey(item)) === claim.id) {
        this.membership.delete(originKey(item));
      }
    }
    if (claim.prNodeId !== null) this.byPrNode.delete(claim.prNodeId);
    return revoked;
  }
}

let defaultStore: OnePrUnitAppStore = new InProcessAppStore();

export function getDefaultAppStore(): OnePrUnitAppStore {
  return defaultStore;
}

export function setDefaultAppStore(store: OnePrUnitAppStore): void {
  defaultStore = store;
}

export function resetDefaultAppStore(): InProcessAppStore {
  const next = new InProcessAppStore();
  defaultStore = next;
  return next;
}
