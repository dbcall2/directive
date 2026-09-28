import { isMarkupPath } from "../observable-scope/extract.js";
import { normalizePath } from "../orchestration/pathspec.js";
import { PRESENTATION_CEILING_ARTIFACT_REL } from "./types.js";
export function normalizeRel(path: string): string {
  return normalizePath(path.replace(/\\/g, "/").replace(/^\.\//, ""));
}
export function pathExtension(path: string): string {
  const name = normalizeRel(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
export function isPresentationPath(path: string): boolean {
  return isMarkupPath(path) || pathExtension(path) === ".css";
}
/** Supplier #5056 forms; lifecycle history is not current restriction authority. */
export function isCeilingArtifactRel(path: string): boolean {
  return (
    path === PRESENTATION_CEILING_ARTIFACT_REL ||
    path.endsWith("/presentation-ceiling.json") ||
    /^xbrief\/(active|pending|proposed)\/.*\.xbrief\.json$/.test(path)
  );
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
