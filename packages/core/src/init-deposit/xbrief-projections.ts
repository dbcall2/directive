/**
 * Idempotent consumer xBRIEF derivatives maintained by init/update (#2595).
 *
 * The framework payload manifest and consumer projections have independent
 * freshness. A current `.deft/core/VERSION` therefore cannot short-circuit
 * these repairs.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { assertProjectionContained } from "../fs/projection-containment.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { DEV_FALLBACK } from "../platform/constants.js";
import { MIGRATED_ARTIFACT_DIR } from "../xbrief-migrate/constants.js";

const OBSOLETE_CORE_SCHEMA = "vbrief-core.schema.json";
const CURRENT_CORE_SCHEMA = "xbrief-core-0.8.schema.json";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectSchemaFiles(root: string, dir = root, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing xbrief schema projection from symlink: ${full}`);
    }
    if (entry.isDirectory()) {
      collectSchemaFiles(root, full, files);
    } else if (entry.isFile()) {
      files.push(relative(root, full));
    }
  }
  return files;
}

function writeFileIfChanged(projectDir: string, target: string, content: Buffer | string): boolean {
  assertProjectionContained(projectDir, target);
  const desired = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  try {
    if (readFileSync(target).equals(desired)) return false;
  } catch {
    // Missing or unreadable target is replaced below.
  }
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, desired);
  return true;
}

/**
 * Synchronize framework-owned xBRIEF schemas while preserving unknown consumer
 * files. The obsolete v0.6 root schema is the only destination-only file this
 * repair removes.
 */
export function syncConsumerXbriefSchemas(projectDir: string, deftDir: string): boolean {
  const sourceDir = join(deftDir, "vbrief", "schemas");
  const currentSource = join(sourceDir, CURRENT_CORE_SCHEMA);
  if (!isDirectory(sourceDir) || !existsSync(currentSource) || !statSync(currentSource).isFile()) {
    throw new Error(
      `cannot project xbrief schemas: framework payload is missing ${CURRENT_CORE_SCHEMA}`,
    );
  }

  const destinationDir = join(projectDir, MIGRATED_ARTIFACT_DIR, "schemas");
  assertProjectionContained(projectDir, destinationDir);
  mkdirSync(destinationDir, { recursive: true });

  let changed = false;
  for (const rel of collectSchemaFiles(sourceDir)) {
    if (rel === OBSOLETE_CORE_SCHEMA) continue;
    const source = join(sourceDir, rel);
    const destination = join(destinationDir, rel);
    changed = writeFileIfChanged(projectDir, destination, readFileSync(source)) || changed;
  }

  const obsoleteDestination = join(destinationDir, OBSOLETE_CORE_SCHEMA);
  assertProjectionContained(projectDir, obsoleteDestination);
  if (existsSync(obsoleteDestination)) {
    rmSync(obsoleteDestination, { force: true });
    changed = true;
  }
  return changed;
}

/** Regenerate the bare consumer version derivative without rewriting it when current. */
export function syncBareVersionMarker(projectDir: string, version: string): boolean {
  const normalized = normalizeVersion(version);
  if (!normalized || normalized === DEV_FALLBACK) return false;

  const canonicalRoot = join(projectDir, MIGRATED_ARTIFACT_DIR);
  if (existsSync(canonicalRoot)) {
    assertProjectionContained(projectDir, join(canonicalRoot, ".deft-version"));
  }
  let targetDir = projectDir;
  try {
    targetDir = resolveLifecycleRoot(projectDir);
  } catch {
    // No canonical artifact layout yet; retain the historical root fallback.
  }
  const target = join(targetDir, ".deft-version");
  return writeFileIfChanged(projectDir, target, `${normalized}\n`);
}
