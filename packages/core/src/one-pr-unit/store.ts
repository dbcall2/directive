/**
 * Facade over the canonical App store. Disk `.deft/one-pr-unit` is not SoT (#4494).
 */

import type { OnePrUnitAppStore } from "./app-store.js";
import { resolveClaimFromStore } from "./app-store.js";
import { getDefaultAppStore } from "./simulator.js";
import { DISK_STORE_NOT_SOT, type OnePrUnitClaim } from "./types.js";

export const ONE_PR_UNIT_DIR = ".deft/one-pr-unit";

export function onePrUnitDir(_projectRoot: string): string {
  throw new Error(DISK_STORE_NOT_SOT);
}

export function onePrUnitGrantPath(_projectRoot: string, _grantId: string): string {
  throw new Error(DISK_STORE_NOT_SOT);
}

export function loadOnePrUnitGrant(
  _projectRoot: string,
  grantId: string,
  store: OnePrUnitAppStore = getDefaultAppStore(),
): OnePrUnitClaim | null {
  return store.getById(grantId);
}

export function writeOnePrUnitGrant(_projectRoot: string, _grant: OnePrUnitClaim): string {
  throw new Error(DISK_STORE_NOT_SOT);
}

export function markOnePrUnitSpent(
  _projectRoot: string,
  grant: OnePrUnitClaim,
  _binding: { readonly repo?: string | null; readonly prNodeId?: string | null },
  _now?: Date,
): OnePrUnitClaim {
  void _projectRoot;
  void _binding;
  void _now;
  return grant;
}

export function listOnePrUnitGrants(
  _projectRoot: string,
  store: OnePrUnitAppStore = getDefaultAppStore(),
): OnePrUnitClaim[] {
  return store.listActive();
}

export function resolveOnePrUnitClaim(
  store: OnePrUnitAppStore,
  input: { readonly id?: string | null; readonly prNodeId?: string | null },
): OnePrUnitClaim | null {
  return resolveClaimFromStore(store, input);
}

export { utcIso } from "./simulator.js";
