import { findAllClosingKeywordHits } from "../pr-closing-keywords/detect.js";
import { normalizeOrigin, uniqueOrigins } from "./origin-set.js";
import type { OriginRef } from "./types.js";

/**
 * Intent closer-set from body/commit text, including one-keyword comma lists
 * (`Closes #4204, #4218, …`). FP-classified hits are not GitHub auto-close.
 */
export function extractIntentCloserSet(texts: readonly string[], repo: string): OriginRef[] {
  const origins: OriginRef[] = [];
  for (const text of texts) {
    for (const hit of findAllClosingKeywordHits(text, "closer-set")) {
      if (hit.reason !== "intent") {
        continue;
      }
      origins.push(normalizeOrigin(repo, hit.issueNumber));
    }
  }
  return uniqueOrigins(origins);
}

export function closerSetFromIssueIds(repo: string, issueIds: readonly number[]): OriginRef[] {
  return uniqueOrigins(issueIds.map((issueId) => normalizeOrigin(repo, issueId)));
}
