/**
 * Rapid check named warning when verify:ac soft-skips after product writes
 * with no lifecycle brief (#4544).
 *
 * Soft-missing stays exit 0 in check composition. Rapid + product writes +
 * no brief is a gate anomaly: report it by name. Do not fail closed here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasArtifactSuffix, LIFECYCLE_DIR_NAMES } from "../layout/resolve.js";
import { isProductAcGate } from "../product-first-done-gate/check-mode.js";
import { LIFECYCLE_FOLDERS, VALID_INFO_ROOT_KEYS } from "../vbrief-validate/constants.js";
import { matchesFilenameConvention } from "../vbrief-validate/filename.js";

export const RAPID_SOFT_MISSING_NO_BRIEF_CAUSE =
  "verify:ac soft-skip with product writes and no lifecycle brief";
export const RAPID_SOFT_MISSING_NO_BRIEF_REMEDY =
  "join setup Phase 3 Starting-new / Rapid and write one xbrief/proposed/ draft, or take Process-only before product writes";
export const RAPID_SOFT_MISSING_NO_BRIEF_NOTICE = `check: warning: ${RAPID_SOFT_MISSING_NO_BRIEF_CAUSE} (#4544); remedy: ${RAPID_SOFT_MISSING_NO_BRIEF_REMEDY}\n`;

/** True when verify:ac text is the #3284 soft-missing skip. */
export function isSoftMissingAcText(text: string): boolean {
  return /verify:ac skipped \(#3284 soft-missing\)/i.test(text);
}

function isPremigrateBackup(name: string): boolean {
  return name.includes(".premigrate.");
}

/** True when a lifecycle candidate is convention-valid and parseable (#4544). */
function isValidLifecycleBriefFile(dir: string, name: string): boolean {
  if (!hasArtifactSuffix(name) || isPremigrateBackup(name) || !matchesFilenameConvention(name)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    const hasInfo = [...VALID_INFO_ROOT_KEYS].some((key) => {
      const info = rec[key];
      return typeof info === "object" && info !== null && !Array.isArray(info);
    });
    const plan = rec.plan;
    return hasInfo && typeof plan === "object" && plan !== null && !Array.isArray(plan);
  } catch {
    return false;
  }
}

export function projectHasLifecycleBrief(projectRoot: string): boolean {
  for (const tree of LIFECYCLE_DIR_NAMES) {
    for (const folder of LIFECYCLE_FOLDERS) {
      const dir = join(projectRoot, tree, folder);
      if (!existsSync(dir)) continue;
      try {
        for (const name of readdirSync(dir)) {
          if (isValidLifecycleBriefFile(dir, name)) {
            return true;
          }
        }
      } catch {
        // unreadable folder is not a brief
      }
    }
  }
  return false;
}

export function sessionRecordedProductWrite(projectRoot: string): boolean {
  const occ = join(projectRoot, ".deft", "occupancy.json");
  if (!existsSync(occ)) return false;
  try {
    const rec = JSON.parse(readFileSync(occ, "utf8")) as { last_write_at?: unknown };
    return typeof rec.last_write_at === "string" && rec.last_write_at.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Rapid check should name the verify:ac soft-skip when this session wrote
 * product files and no lifecycle brief exists.
 */
export function rapidCheckWarnsSoftMissingNoBrief(input: {
  readonly mode: string;
  readonly gateId: string;
  readonly acText: string;
  readonly hasLifecycleBrief: boolean;
  readonly sessionChangedProductFiles: boolean;
}): boolean {
  return (
    input.mode === "rapid" &&
    isProductAcGate(input.gateId) &&
    isSoftMissingAcText(input.acText) &&
    !input.hasLifecycleBrief &&
    input.sessionChangedProductFiles
  );
}
