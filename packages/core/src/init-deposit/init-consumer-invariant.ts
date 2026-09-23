/**
 * Init/update consumer-file postcondition (#4533).
 *
 * Before init reports success, re-read the pin and managed-section presence
 * (and `.gitignore` when that file is in the invariant). If either is missing,
 * call the existing writers once. If still missing, return a refuse message
 * that names the remaining files and re-run `directive init` / `directive update`
 * after the other scaffolder is quiet.
 *
 * Deposit-present + pin-absent restores the pin with `ensurePackageJsonPin`
 * at the recorded deposit version. That hole does not go through
 * `reconstituteConsumerPinAndLock` (#4710 lockfile-only spawn stays leftover
 * on #4429).
 */

import { existsSync } from "node:fs";
import { hasManagedSectionMarker } from "../platform/agents-md.js";
import { readPin } from "../resolution/pin.js";
import {
  type EnsureInitGitignoreResult,
  ensureInitGitignoreLines,
  initGitignoreInvariantMissing,
} from "./gitignore.js";
import {
  type EnsurePackageJsonPinResult,
  ensurePackageJsonPin,
  type InitDepositIo,
  writeAgentsMd,
} from "./scaffold.js";

export const INIT_CONSUMER_INVARIANT_REFUSE_RECOVERY =
  "Re-run `directive init` / `directive update` after the other scaffolder is quiet.";

export interface InitConsumerInvariantGap {
  readonly pinMissing: boolean;
  readonly agentsMissing: boolean;
  readonly gitignoreMissing: boolean;
}

function joinOrList(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

/** Names only the consumer files this invariant still finds missing. */
export function formatInitConsumerInvariantRefuseMessage(gap: InitConsumerInvariantGap): string {
  const parts: string[] = [];
  if (gap.pinMissing) parts.push("@deftai/directive pin");
  if (gap.agentsMissing) parts.push("AGENTS.md managed section");
  if (gap.gitignoreMissing) parts.push(".gitignore");
  const listed =
    joinOrList(parts) || "@deftai/directive pin, AGENTS.md managed section, or .gitignore";
  return `${listed} missing after re-assert. ${INIT_CONSUMER_INVARIANT_REFUSE_RECOVERY}`;
}

/** Covering wording for every TS-checked consumer file. Prefer the gap formatter. */
export const INIT_CONSUMER_INVARIANT_REFUSE_MESSAGE = formatInitConsumerInvariantRefuseMessage({
  pinMissing: true,
  agentsMissing: true,
  gitignoreMissing: true,
});

export interface InitConsumerInvariantWriters {
  readonly ensurePackageJsonPin?: (
    projectDir: string,
    version: string,
    io: InitDepositIo,
  ) => EnsurePackageJsonPinResult;
  readonly writeAgentsMd?: (projectDir: string, deftDir: string, io: InitDepositIo) => boolean;
  readonly ensureInitGitignoreLines?: (
    projectDir: string,
    io: InitDepositIo,
  ) => EnsureInitGitignoreResult;
}

export function inspectInitConsumerInvariant(projectDir: string): InitConsumerInvariantGap {
  return {
    pinMissing: readPin(projectDir).pinVersion === null,
    agentsMissing: !hasManagedSectionMarker(projectDir),
    gitignoreMissing: initGitignoreInvariantMissing(projectDir),
  };
}

export function initConsumerInvariantHolds(gap: InitConsumerInvariantGap): boolean {
  return !gap.pinMissing && !gap.agentsMissing && !gap.gitignoreMissing;
}

export function reassertInitConsumerInvariant(input: {
  readonly projectDir: string;
  readonly deftDir: string;
  readonly pinVersion: string;
  readonly io: InitDepositIo;
  readonly writers?: InitConsumerInvariantWriters;
}): { gap: InitConsumerInvariantGap; refuseMessage: string | null } {
  const first = inspectInitConsumerInvariant(input.projectDir);
  if (initConsumerInvariantHolds(first)) {
    return { gap: first, refuseMessage: null };
  }

  const pinWriter = input.writers?.ensurePackageJsonPin ?? ensurePackageJsonPin;
  const agentsWriter = input.writers?.writeAgentsMd ?? writeAgentsMd;
  const gitignoreWriter = input.writers?.ensureInitGitignoreLines ?? ensureInitGitignoreLines;

  if (first.pinMissing) {
    pinWriter(input.projectDir, input.pinVersion, input.io);
  }
  if (first.agentsMissing) {
    agentsWriter(input.projectDir, input.deftDir, input.io);
  }
  if (first.gitignoreMissing) {
    gitignoreWriter(input.projectDir, input.io);
  }

  const second = inspectInitConsumerInvariant(input.projectDir);
  return {
    gap: second,
    refuseMessage: initConsumerInvariantHolds(second)
      ? null
      : formatInitConsumerInvariantRefuseMessage(second),
  };
}

/**
 * Deposit present + pin absent: write the pin at the recorded deposit version.
 * Does not spawn lockfile-only reconstitution (#4533 / leftover #4429).
 */
export function restoreNullPinAtRecordedDepositVersion(input: {
  readonly projectDir: string;
  readonly deftDir: string;
  readonly recordedVersion: string | null;
  readonly io: InitDepositIo;
}): boolean {
  if (!existsSync(input.deftDir)) return false;
  if (readPin(input.projectDir).pinVersion !== null) return false;
  const version = input.recordedVersion?.trim() ?? "";
  if (version === "") return false;
  ensurePackageJsonPin(input.projectDir, version, input.io);
  return true;
}
