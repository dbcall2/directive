/**
 * Presentation-class path helpers (#5056 built-in set / #5079 item 9).
 */

import { isMarkupPath } from "../observable-scope/extract.js";
import { normalizePath } from "../orchestration/pathspec.js";
import { BUILTIN_PRESENTATION_EXTENSIONS, PRESENTATION_CEILING_DIR } from "./types.js";

export function normalizeRel(path: string): string {
  return normalizePath(path.replace(/\\/g, "/"));
}

export function pathExtension(path: string): string {
  const posix = normalizeRel(path);
  const base = posix.split("/").pop() ?? posix;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isCssPath(path: string): boolean {
  return pathExtension(path) === ".css";
}

/** Built-in presentation set: markup plus `.css`. */
export function isPresentationPath(path: string): boolean {
  return isMarkupPath(path) || isCssPath(path);
}

export function isCeilingArtifactRel(path: string): boolean {
  const posix = normalizeRel(path);
  if (!posix.startsWith(`${PRESENTATION_CEILING_DIR}/`)) return false;
  return posix.endsWith(".json");
}

export function normalizeExtensionToken(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

export function isBuiltinPresentationExtension(ext: string): boolean {
  const token = normalizeExtensionToken(ext);
  return (BUILTIN_PRESENTATION_EXTENSIONS as readonly string[]).includes(token);
}
