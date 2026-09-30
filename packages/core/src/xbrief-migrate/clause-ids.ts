/**
 * One-shot leftover `clause:N` → `clause.N` corpus hop (#5011).
 *
 * Reuses {@link rewriteLegacyClauseKeyedItemIds}; does not invent a second
 * rewrite. Named by doctor / `deft update`. Does not run inside deposit refresh.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertDirectoryNotSymlink } from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { rewriteLegacyClauseKeyedItemIds } from "../scope/acceptance-evidence.js";
import { LIFECYCLE_FOLDERS } from "../vbrief-validate/constants.js";

type JsonObject = Record<string, unknown>;

export const CLAUSE_ID_MIGRATE_COMMAND = "deft migrate:clause-ids" as const;

export interface LegacyClauseIdHit {
  readonly path: string;
  readonly rewrittenIds: readonly string[];
}

export interface LegacyClauseIdScan {
  readonly scanned: number;
  readonly hits: readonly LegacyClauseIdHit[];
}

export interface CorpusMigrationConflict {
  readonly path: string;
  readonly message: string;
}

export interface CorpusMigrationResult {
  readonly scanned: number;
  readonly changed: readonly string[];
  readonly conflicts: readonly CorpusMigrationConflict[];
}

export interface ParsedMigrateClauseIdsArgs {
  projectRoot: string;
  error?: string;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CorpusWalk {
  files: string[];
  skippedSymlinks: string[];
}

const VALIDATE_VISIBLE_FOLDERS = new Set(LIFECYCLE_FOLDERS);

/** Brief-named links, plus lifecycle-folder dir links that discoverVbriefs follows. */
function isValidateVisibleSymlink(corpusDir: string, full: string, name: string): boolean {
  if (hasArtifactSuffix(name)) {
    return true;
  }
  const rel = relative(corpusDir, full).replace(/\\/g, "/");
  if (!VALIDATE_VISIBLE_FOLDERS.has(rel)) {
    return false;
  }
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function collectVbriefFiles(
  dir: string,
  acc: CorpusWalk = { files: [], skippedSymlinks: [] },
  corpusDir: string = dir,
): CorpusWalk {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let isLink = entry.isSymbolicLink();
    let info: ReturnType<typeof lstatSync> | undefined;
    if (!isLink) {
      try {
        info = lstatSync(full);
        isLink = info.isSymbolicLink();
      } catch {
        continue;
      }
    }
    if (isLink) {
      if (isValidateVisibleSymlink(corpusDir, full, entry.name)) {
        acc.skippedSymlinks.push(full);
      }
      continue;
    }
    const isDir = entry.isDirectory() || info?.isDirectory() === true;
    const isFile = entry.isFile() || info?.isFile() === true;
    if (isDir) {
      collectVbriefFiles(full, acc, corpusDir);
    } else if (isFile && hasArtifactSuffix(entry.name)) {
      acc.files.push(full);
    }
  }
  return acc;
}

function collectPlanItemIds(items: unknown[]): string[] {
  const ids: string[] = [];
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const obj = item as JsonObject;
      if (typeof obj.id === "string") {
        ids.push(obj.id);
      }
      walk(obj.subItems);
      walk(obj.items);
    }
  };
  walk(items);
  return ids;
}

function countIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function rewriteIntroducesDuplicate(before: unknown[], after: unknown[]): boolean {
  const beforeCounts = countIds(collectPlanItemIds(before));
  const afterCounts = countIds(collectPlanItemIds(after));
  for (const [id, n] of afterCounts) {
    if (n > 1 && n > (beforeCounts.get(id) ?? 0)) {
      return true;
    }
  }
  return false;
}

function selectFallbackCorpusDir(projectRoot: string): string | null {
  const xbriefDir = join(projectRoot, "xbrief");
  const legacyDir = join(projectRoot, "vbrief");
  const xbriefExists = existsSync(xbriefDir);
  if (xbriefExists) {
    const walk = collectVbriefFiles(xbriefDir);
    if (walk.files.length > 0 || walk.skippedSymlinks.length > 0) {
      return xbriefDir;
    }
  }
  if (existsSync(legacyDir)) {
    return legacyDir;
  }
  return xbriefExists ? xbriefDir : null;
}

function resolveCorpusDir(projectRoot: string): { dir: string } | { conflict: string } | null {
  let corpusDir: string;
  try {
    corpusDir = resolveLifecycleRoot(projectRoot);
  } catch {
    const fallback = selectFallbackCorpusDir(projectRoot);
    if (fallback === null) {
      return null;
    }
    corpusDir = fallback;
  }
  try {
    assertDirectoryNotSymlink(projectRoot, corpusDir, "lifecycle root");
  } catch (err) {
    return { conflict: err instanceof Error ? err.message : String(err) };
  }
  return { dir: corpusDir };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function planItems(doc: unknown): unknown[] | null {
  if (!isPlainObject(doc)) {
    return null;
  }
  const plan = doc.plan;
  if (!isPlainObject(plan) || !Array.isArray(plan.items)) {
    return null;
  }
  return plan.items;
}

function detectLegacyIds(items: unknown[]): string[] {
  return rewriteLegacyClauseKeyedItemIds(cloneJson(items));
}

export function scanLegacyClauseKeyedItemIds(projectRoot: string): LegacyClauseIdScan {
  const root = resolve(projectRoot);
  const resolved = resolveCorpusDir(root);
  if (resolved === null || "conflict" in resolved) {
    return { scanned: 0, hits: [] };
  }
  const hits: LegacyClauseIdHit[] = [];
  let scanned = 0;
  for (const file of collectVbriefFiles(resolved.dir).files) {
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const items = planItems(parsed);
    if (items === null) {
      continue;
    }
    const rewrittenIds = detectLegacyIds(items);
    if (rewrittenIds.length > 0) {
      hits.push({
        path: relative(root, file).replace(/\\/g, "/"),
        rewrittenIds,
      });
    }
  }
  return { scanned, hits };
}

export function migrateLegacyClauseKeyedItemIdsCorpus(projectRoot: string): CorpusMigrationResult {
  const root = resolve(projectRoot);
  const resolved = resolveCorpusDir(root);
  if (resolved === null) {
    return { scanned: 0, changed: [], conflicts: [] };
  }
  if ("conflict" in resolved) {
    return {
      scanned: 0,
      changed: [],
      conflicts: [{ path: relative(root, join(root, "xbrief")), message: resolved.conflict }],
    };
  }

  let scanned = 0;
  const changed: string[] = [];
  const conflicts: CorpusMigrationConflict[] = [];
  const walk = collectVbriefFiles(resolved.dir);
  for (const skipped of walk.skippedSymlinks) {
    conflicts.push({
      path: relative(root, skipped).replace(/\\/g, "/"),
      message: "skipped symlink; vbrief:validate may still reject leftover clause:N inside",
    });
  }

  for (const file of walk.files) {
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (
      !isPlainObject(parsed) ||
      !isPlainObject(parsed.plan) ||
      !Array.isArray(parsed.plan.items)
    ) {
      continue;
    }
    const original = parsed.plan.items;
    const rewritten = cloneJson(original);
    const rewrittenIds = rewriteLegacyClauseKeyedItemIds(rewritten);
    if (rewrittenIds.length === 0) {
      continue;
    }
    const relPath = relative(root, file).replace(/\\/g, "/");
    if (rewriteIntroducesDuplicate(original, rewritten)) {
      conflicts.push({
        path: relPath,
        message: "rewrite would duplicate PlanItem ids (clause:N collides with existing clause.N)",
      });
      continue;
    }
    parsed.plan.items = rewritten;
    try {
      containedWrite({
        root,
        target: file,
        data: `${JSON.stringify(parsed, null, 2)}\n`,
        mode: "replace",
      });
    } catch (err) {
      conflicts.push({
        path: relPath,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    changed.push(relPath);
  }

  return { scanned, changed: changed.sort(), conflicts };
}

export function renderLegacyClauseIdLine(projectRoot: string): string {
  const scan = scanLegacyClauseKeyedItemIds(projectRoot);
  if (scan.hits.length === 0) {
    return "Legacy clause ids: none -- no leftover clause:N PlanItem ids.";
  }
  const idCount = scan.hits.reduce((n, hit) => n + hit.rewrittenIds.length, 0);
  return (
    `Legacy clause ids: fail -- ${idCount} leftover clause:N PlanItem id(s) in ` +
    `${scan.hits.length} brief(s). Run \`${CLAUSE_ID_MIGRATE_COMMAND}\`.`
  );
}

export function legacyClauseIdSignpostSuffix(projectRoot: string): string {
  const scan = scanLegacyClauseKeyedItemIds(projectRoot);
  if (scan.hits.length === 0) {
    return "";
  }
  const idCount = scan.hits.reduce((n, hit) => n + hit.rewrittenIds.length, 0);
  return (
    `Legacy clause:N PlanItem ids remain (${idCount} in ${scan.hits.length} brief(s)). ` +
    `Run \`${CLAUSE_ID_MIGRATE_COMMAND}\`.`
  );
}

export function printLegacyClauseIdNudgeIfNeeded(
  projectRoot: string,
  io: { printf: (text: string) => void },
): void {
  const line = renderLegacyClauseIdLine(projectRoot);
  if (!line.includes(CLAUSE_ID_MIGRATE_COMMAND)) {
    return;
  }
  io.printf(`\n[deft] ${line}\n`);
}

export function parseArgs(argv: readonly string[]): ParsedMigrateClauseIdsArgs {
  let projectRoot = ".";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { projectRoot, error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg !== "--help" && arg !== "-h") {
      return { projectRoot, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot };
}

const HELP =
  "Usage: deft migrate:clause-ids [--project-root <path>]\n" +
  "Rewrite leftover clause:N PlanItem ids to clause.N across lifecycle briefs, " +
  "including cancelled/ and completed/.\n";

export function run(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`migrate:clause-ids: ${args.error}\n`);
    return 2;
  }

  const result = migrateLegacyClauseKeyedItemIdsCorpus(args.projectRoot);
  if (result.conflicts.length > 0) {
    for (const conflict of result.conflicts) {
      process.stderr.write(
        `migrate:clause-ids: conflict in ${conflict.path}: ${conflict.message}\n`,
      );
    }
    return 1;
  }
  if (result.changed.length === 0) {
    process.stdout.write(
      `migrate:clause-ids: ${result.scanned} lifecycle brief(s) scanned -- already clause.N.\n`,
    );
    return 0;
  }
  process.stdout.write(
    `migrate:clause-ids: rewrote ${result.changed.length} of ${result.scanned} lifecycle brief(s):\n`,
  );
  for (const path of result.changed) {
    process.stdout.write(`  ${path}\n`);
  }
  return 0;
}

export function mainEntry(argv: readonly string[]): number {
  return run(argv);
}
