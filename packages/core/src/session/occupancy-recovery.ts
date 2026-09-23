/**
 * Occupancy-aware stale-ritual recovery (#4290).
 *
 * Recovery copy is a projection of ceremony eligibility, not a static
 * session:ready / --rearm suffix. Preview and persist share
 * evaluateOccupancyCeremonyEligibility; this module only formats and
 * rewrites denial text so embedded ritual commands cannot advertise a
 * ceremony occupancy would refuse.
 */

import { formatFrameworkCommand } from "../render/framework-commands.js";
import {
  type ApplyOccupancyInput,
  evaluateOccupancyCeremonyEligibility,
  type OccupancyCeremonyEligibility,
} from "./occupancy.js";
import { formatSessionStartRecoveryCommand, type SessionCeremonyTier } from "./session-start.js";
import { formatRitualRecoveryInstruction } from "./verify-session-ritual.js";

/** Dedicated writes and recognized in-repo shell forms vs unrecognized shell. */
export const SHELL_COVERAGE_HONESTY =
  "Dedicated Write/Edit and recognized in-repository shell forms are gated; " +
  "unrecognized shell forms remain outside that coverage.";

export function formatOccupancyAwareRitualRecovery(
  eligibility: OccupancyCeremonyEligibility,
  tier: SessionCeremonyTier = "cold",
): string {
  if (eligibility.admitCeremony) {
    return `${formatRitualRecoveryInstruction(tier)} ${SHELL_COVERAGE_HONESTY}`;
  }
  const denial = eligibility.denialMessage?.trim() ?? "";
  if (denial.length === 0) {
    return SHELL_COVERAGE_HONESTY;
  }
  if (denial.includes("recognized in-repository shell")) {
    return denial;
  }
  return `${denial} ${SHELL_COVERAGE_HONESTY}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripUnauthorizedCeremonyCommands(text: string): string {
  const ready = formatFrameworkCommand(["session:ready"]);
  const rearm = formatSessionStartRecoveryCommand("rearm");
  const cold = formatSessionStartRecoveryCommand("cold");
  let next = text;
  const patterns: readonly RegExp[] = [
    new RegExp(`Recovery:\\s*run\\s+\`${escapeRegExp(ready)}\`[^.]*\\.`, "gi"),
    new RegExp(`Recovery:\\s*run\\s+${escapeRegExp(ready)}[^.]*\\.`, "gi"),
    new RegExp(
      `Run\\s+\`${escapeRegExp(rearm)}[^\`]*\`\\s+to re-arm\\s+\\(or\\s+\`${escapeRegExp(cold)}[^\`]*\`[^)]*\\)\\.`,
      "gi",
    ),
    /Run `deft session:start --rearm --session-id=<same-session-id>` when re-arm is eligible; otherwise run `deft session:start --session-id=<same-session-id>` for a cold ceremony\.(?: Intermediate lease\/ritual mismatches fail closed\.)?/gi,
    /`(?:deft|directive|task)\s+session:ready(?:\s+--(?:\s+)?\S+)*`/gi,
    /(?:deft|directive|task)\s+session:ready(?:\s+--(?:\s+)?\S+)*/gi,
    /`(?:deft|directive|task)\s+session:start\s+--rearm(?:\s+--session-id=\S+)?(?:\s+--\s+\S+)*`/gi,
    /(?:deft|directive|task)\s+session:start\s+--rearm(?:\s+--session-id=\S+)?/gi,
    /`(?:deft|directive|task)\s+session:start(?:\s+--session-id=\S+)?`/gi,
    /(?:deft|directive|task)\s+session:start(?!\s+--(?:primary-claim-exception|read-only|rearm)|\s+--\s+--defer)/gi,
  ];
  for (const pattern of patterns) {
    next = next.replace(pattern, "");
  }
  return next
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function alreadyNamesOccupancyRecovery(text: string): boolean {
  return (
    text.includes("primary checkout") ||
    text.includes("Worktree occupied") ||
    text.includes("primary-claim-exception") ||
    text.includes("owner-only") ||
    text.includes("must not mutation-claim") ||
    text.includes("Do not steal this lease")
  );
}

/**
 * Apply eligibility to the complete denial, including embedded ritual
 * commands, not only the Recovery: suffix (#4290).
 */
export function applyOccupancyEligibilityToDenial(
  message: string,
  eligibility: OccupancyCeremonyEligibility,
  tier: SessionCeremonyTier = "cold",
): string {
  if (eligibility.admitCeremony) {
    const recovery = formatOccupancyAwareRitualRecovery(eligibility, tier);
    if (/\bsession:ready\b/.test(message) && /one-shot/.test(message)) {
      return message.includes("recognized in-repository shell")
        ? message
        : `${message} ${SHELL_COVERAGE_HONESTY}`;
    }
    return `${message} ${recovery}`;
  }
  const stripped = stripUnauthorizedCeremonyCommands(message);
  const occupancyRecovery = formatOccupancyAwareRitualRecovery(eligibility, tier);
  if (alreadyNamesOccupancyRecovery(stripped)) {
    return stripped.includes("recognized in-repository shell")
      ? stripped
      : `${stripped} ${SHELL_COVERAGE_HONESTY}`;
  }
  if (stripped.length === 0) return occupancyRecovery;
  return `${stripped} ${occupancyRecovery}`;
}

export function occupancyAwareDenialMessage(
  projectRoot: string,
  message: string,
  input: ApplyOccupancyInput = {},
  tier: SessionCeremonyTier = "cold",
): string {
  const eligibility = evaluateOccupancyCeremonyEligibility(projectRoot, input);
  return applyOccupancyEligibilityToDenial(message, eligibility, tier);
}
