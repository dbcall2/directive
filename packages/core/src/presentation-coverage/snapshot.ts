/** Names and bytes share immutable Git objects. Missing is distinct from unreadable.
 * Staged mode compares the complete index tree to the merge base, including the
 * committed branch delta. Renames are del/add pairs; unresolved indexes refuse.
 */
import { spawnSync } from "node:child_process";
import { resolveIntentConstraintOrigin } from "../intent-constraint/evaluate.js";
export interface SnapshotTree {
  readonly paths: readonly string[];
  readonly errors: string[];
  readonly read: (path: string) => string | null;
}
export interface CoverageSnapshot {
  readonly projectRoot: string;
  readonly mergeBase: string;
  readonly candidate: string;
  readonly changed: readonly string[];
  readonly base: SnapshotTree;
  readonly head: SnapshotTree;
}
function git(root: string, args: readonly string[]): string | { error: string } {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.error !== undefined || r.status !== 0
    ? { error: `git ${args[0]} failed: ${r.error?.message ?? r.stderr.trim()}` }
    : r.stdout;
}
function tree(root: string, ref: string): SnapshotTree | { error: string } {
  const ls = git(root, ["ls-tree", "-rz", "--full-tree", ref]);
  if (typeof ls !== "string") return ls;
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const row of ls.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    const [mode, kind, oid] = row.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !oid || !kind) return { error: `invalid git tree listing: ${ref}` };
    entries.set(row.slice(tab + 1), { mode, oid });
  }
  const errors: string[] = [];
  const cache = new Map<string, string | null>();
  return {
    paths: [...entries.keys()],
    errors,
    read: (path) => {
      if (cache.has(path)) return cache.get(path) ?? null;
      const e = entries.get(path);
      if (e === undefined) return null;
      if (e.mode !== "100644" && e.mode !== "100755") {
        errors.push(`unsupported mode ${e.mode} at ${ref}:${path}`);
        cache.set(path, null);
        return null;
      }
      const bytes = git(root, ["cat-file", "blob", e.oid]);
      if (typeof bytes !== "string") {
        errors.push(`unreadable ${ref}:${path}: ${bytes.error}`);
        cache.set(path, null);
        return null;
      }
      cache.set(path, bytes);
      return bytes;
    },
  };
}
export function loadSnapshot(options: {
  readonly projectRoot: string;
  readonly originRef?: string;
  readonly staged?: boolean;
}): CoverageSnapshot | { error: string } {
  const root = options.projectRoot;
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  if (typeof head !== "string") return head;
  const origin = resolveIntentConstraintOrigin(root, options.originRef);
  if ("error" in origin) return origin;
  const mb = git(root, ["merge-base", head.trim(), origin.origin]);
  if (typeof mb !== "string") return mb;
  const candidate = options.staged === true ? git(root, ["write-tree"]) : head;
  if (typeof candidate !== "string") return candidate;
  const base = tree(root, mb.trim());
  if ("error" in base) return base;
  const next = tree(root, candidate.trim());
  if ("error" in next) return next;
  const diff = git(root, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    mb.trim(),
    candidate.trim(),
    "--",
  ]);
  if (typeof diff !== "string") return diff;
  return {
    projectRoot: root,
    mergeBase: mb.trim(),
    candidate: candidate.trim(),
    changed: diff.split("\0").filter(Boolean),
    base,
    head: next,
  };
}
export function readTexts(
  tree: SnapshotTree,
  predicate: (path: string) => boolean,
): Map<string, string> {
  const texts = new Map<string, string>();
  for (const path of tree.paths.filter(predicate)) {
    const text = tree.read(path);
    if (text !== null) texts.set(path, text);
  }
  return texts;
}
