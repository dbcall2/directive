/**
 * Tip-measure packed-deposit broken links after stageContentPack (#4890).
 *
 * Unexpected: pack-mapped + source-exists (shippable flatten misses).
 * Residuals: unmapped or source-missing targets (NAMED_PACK_RESIDUALS membership).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrokenLink } from "../validate-content/validate-links.js";
import {
  resolveSourceTargetRel,
  rewriteRelativeLink,
  sourceRelForPackRel,
  splitLinkHash,
} from "./rewrite-deposit-links.js";

export interface PackedLinkResidualMeasure {
  readonly unexpected: readonly string[];
  readonly residualTargets: readonly string[];
}

/** Classify collectBrokenLinks hits on a staged pack against the source tree. */
export function classifyPackedDepositBrokenLinks(options: {
  readonly broken: readonly BrokenLink[];
  readonly repoRoot: string;
}): PackedLinkResidualMeasure {
  const unexpected: string[] = [];
  const residuals = new Set<string>();
  for (const item of options.broken) {
    const packFileRel = item.file.replace(/\\/g, "/");
    const sourceFileRel = sourceRelForPackRel(packFileRel);
    const mapped = rewriteRelativeLink({
      sourceFileRel,
      packFileRel,
      target: item.target,
    });
    const rawPath = splitLinkHash(item.target).path;
    const sourceTarget = resolveSourceTargetRel(sourceFileRel, rawPath);
    const sourceExists = existsSync(join(options.repoRoot, ...sourceTarget.split("/")));
    if (mapped.packMapped && sourceExists) {
      unexpected.push(`${item.file}:${item.line} -> ${item.target}`);
    } else {
      residuals.add(rawPath || item.target);
    }
  }
  return {
    unexpected,
    residualTargets: [...residuals].sort(),
  };
}
