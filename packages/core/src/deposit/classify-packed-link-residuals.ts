/**
 * Tip-measure packed-deposit broken links after stageContentPack (#4890).
 *
 * Unexpected: pack-mapped + source-exists (shippable flatten misses).
 * Residuals: unmapped or source-missing targets (NAMED_PACK_RESIDUALS membership).
 */

import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { BrokenLink } from "../validate-content/validate-links.js";
import {
  mapSourceToPackRelative,
  resolveSourceTargetRel,
  rewriteRelativeLink,
  sourceRelForPackRel,
  splitLinkHash,
} from "./rewrite-deposit-links.js";

export interface PackedLinkResidualMeasure {
  readonly unexpected: readonly string[];
  readonly residualTargets: readonly string[];
}

function packPathEscapes(packAbs: string): boolean {
  return packAbs === ".." || packAbs.startsWith("../");
}

/**
 * Source-tree path for a staged-pack broken href.
 * Unrewritten leftovers still look source-relative (`rewritten`); already-flattened
 * hrefs resolve through the pack layout so `../main.md` from `meta/security.md`
 * maps to repo `main.md`, not `content/main.md`.
 */
function sourceTargetForPackedBrokenLink(options: {
  readonly packFileRel: string;
  readonly sourceFileRel: string;
  readonly rawPath: string;
  readonly rewritten: boolean;
}): string {
  const { packFileRel, sourceFileRel, rawPath, rewritten } = options;
  if (rewritten) {
    return resolveSourceTargetRel(sourceFileRel, rawPath);
  }
  const packAbs = posix.normalize(posix.join(posix.dirname(packFileRel), rawPath || "."));
  if (packPathEscapes(packAbs)) {
    return resolveSourceTargetRel(sourceFileRel, rawPath);
  }
  return sourceRelForPackRel(packAbs);
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
    const sourceTarget = sourceTargetForPackedBrokenLink({
      packFileRel,
      sourceFileRel,
      rawPath,
      rewritten: mapped.rewritten,
    });
    const sourceExists = existsSync(join(options.repoRoot, ...sourceTarget.split("/")));
    const packMapped = mapped.rewritten
      ? mapped.packMapped
      : mapSourceToPackRelative(sourceTarget) !== null;
    if (packMapped && sourceExists) {
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
