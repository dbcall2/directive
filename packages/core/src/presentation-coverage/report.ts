/** Consume the CLI's typed result; never parse N/A prose as a gate verdict. */
import { COMPOSED_GATE_IDS } from "./gates.js";
import { isRecord } from "./paths.js";
import type { ComposedGateCoverage } from "./types.js";
export function parseCoverageReport(
  text: string,
  exitCode: number,
): { armed: boolean; coverage: ComposedGateCoverage[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Task dependencies may print build diagnostics before the CLI's single-line
    // JSON report. Only that terminal report is evidence. JSON-like prefixes
    // are ambiguous (including duplicate/pretty-printed reports), never logs.
    const lines = text.trim().split(/\r?\n/);
    const terminal = lines.pop() ?? "";
    if (lines.some((line) => /^\s*(?:\{|\[\s*\{)/.test(line)))
      return { error: "presentation coverage result has ambiguous JSON prefix" };
    try {
      raw = JSON.parse(terminal);
    } catch {
      return { error: "presentation coverage result missing or invalid JSON" };
    }
  }
  if (
    !isRecord(raw) ||
    raw.code !== exitCode ||
    typeof raw.armed !== "boolean" ||
    !Array.isArray(raw.coverage)
  )
    return { error: "presentation coverage result does not match process outcome" };
  const rows: ComposedGateCoverage[] = [];
  for (const r of raw.coverage) {
    if (
      !isRecord(r) ||
      typeof r.gateId !== "string" ||
      !["evaluated", "skipped", "unrun"].includes(String(r.status)) ||
      ![0, 1, 2, null].includes(r.code as number | null) ||
      !Array.isArray(r.analyzedPaths) ||
      r.analyzedPaths.some((p) => typeof p !== "string") ||
      !Array.isArray(r.cannotEvaluatePaths) ||
      r.cannotEvaluatePaths.some((p) => typeof p !== "string") ||
      typeof r.message !== "string"
    )
      return { error: "invalid typed presentation coverage row" };
    rows.push(r as unknown as ComposedGateCoverage);
  }
  if (raw.armed && exitCode === 0) {
    if (
      rows.length !== COMPOSED_GATE_IDS.length ||
      !Array.isArray(raw.uncoveredPaths) ||
      raw.uncoveredPaths.length > 0 ||
      COMPOSED_GATE_IDS.some(
        (id) =>
          rows.filter((r) => r.gateId === id && r.code === 0 && r.status !== "unrun").length !== 1,
      )
    )
      return { error: "armed presentation coverage omitted or failed a required evaluator" };
  }
  return { armed: raw.armed, coverage: rows };
}
