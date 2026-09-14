/**
 * Automated close only through the App after consume (#4494).
 * No DEFT_ALLOW_* escape. UI/raw API closes are recovery-class.
 */

import type { OnePrUnitAppStore } from "./app-store.js";
import { uniqueOrigins } from "./origin-set.js";
import type { OriginRef } from "./types.js";

export const DEFT_ALLOW_ISSUE_CLOSE = "DEFT_ALLOW_ISSUE_CLOSE";

export const CLAIMED_SET_REQUIRED =
  "automated close requires a claimed origin set presented to the App (restCloseIssue / umbrella reconcile)";

export const DEFT_ALLOW_NOT_ESCAPE =
  "DEFT_ALLOW_* is a measured violation, not an escape from one-PR-unit App close";

export const RECOVERY_CLASS_NON_APP_CLOSE =
  "recovery-class: closed_by is not the Directive App; webhook reopen is recovery, not prevention";

export interface AppCloseInput {
  readonly store: OnePrUnitAppStore;
  readonly prNodeId: string;
  readonly claimedSet: readonly OriginRef[];
  readonly now?: Date;
}

export function assertNoDeftAllowEscape(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("DEFT_ALLOW_")) continue;
    if (value === "1" || value === "true") {
      throw new Error(`${DEFT_ALLOW_NOT_ESCAPE} (${key})`);
    }
  }
}

export function consumeClaimedSet(input: AppCloseInput): void {
  assertNoDeftAllowEscape();
  const claimed = uniqueOrigins(input.claimedSet);
  if (claimed.length === 0) {
    throw new Error(CLAIMED_SET_REQUIRED);
  }
  input.store.consume(input.prNodeId, claimed, input.now);
}

export function isAppActor(closedBy: string | null | undefined, appSlug = "directive"): boolean {
  if (closedBy === null || closedBy === undefined) return false;
  const login = closedBy.trim().toLowerCase();
  return login === appSlug.toLowerCase() || login === `${appSlug.toLowerCase()}[bot]`;
}

export function classifyNonAppClose(closedBy: string | null | undefined): {
  readonly recoveryClass: true;
  readonly message: string;
} {
  return {
    recoveryClass: true,
    message: `${RECOVERY_CLASS_NON_APP_CLOSE} (closed_by=${closedBy ?? "unknown"})`,
  };
}

export function classifyDirectDefaultBranchClose(input: {
  readonly mergeGroupCheckPassed: boolean;
  readonly allowDirectCommitsToMaster: boolean;
}): { readonly recoveryClass: true; readonly message: string } {
  void input.allowDirectCommitsToMaster;
  if (!input.mergeGroupCheckPassed) {
    return {
      recoveryClass: true,
      message:
        "recovery-class: default-branch Closes without merge_group.checks_requested App check; allowDirectCommitsToMaster does not bypass reservation",
    };
  }
  return {
    recoveryClass: true,
    message: "recovery-class: default-branch close path is not the merge-queue App check",
  };
}
