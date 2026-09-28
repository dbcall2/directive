/** Scope provenance still has disk recovery/read fallbacks. Give it a disposable
 * Git checkout of the pinned candidate, never the user's mutable working tree.
 * read-tree/commit-tree do not run repository hooks; the new repo has no template.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  evaluateScopeProvenance,
  type ScopeProvenanceOptions,
  type ScopeProvenanceResult,
} from "../scope-provenance/evaluate.js";
import type { CoverageSnapshot } from "./snapshot.js";
export function evaluateIsolatedScope(
  snapshot: CoverageSnapshot,
  options: ScopeProvenanceOptions,
): ScopeProvenanceResult {
  const directory = mkdtempSync(join(tmpdir(), "deft-coverage-scope-"));
  const error = (message: string): ScopeProvenanceResult => ({
    exitCode: 2,
    findings: [],
    message,
  });
  const git = (root: string, args: string[]) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Snapshot",
        GIT_AUTHOR_EMAIL: "snapshot@example.invalid",
        GIT_COMMITTER_NAME: "Snapshot",
        GIT_COMMITTER_EMAIL: "snapshot@example.invalid",
      },
    });
  try {
    const objects = git(snapshot.projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    if (objects.status !== 0) return error(`scope snapshot objects unavailable: ${objects.stderr}`);
    const init = git(directory, ["init", "--quiet", "--template="]);
    if (init.status !== 0) return error(`scope snapshot init failed: ${init.stderr}`);
    containedWrite({
      root: directory,
      target: ".git/objects/info/alternates",
      data: `${objects.stdout.trim()}\n`,
      mode: "create",
    });
    const tree = git(directory, ["rev-parse", `${snapshot.candidate}^{tree}`]);
    if (tree.status !== 0) return error(`scope snapshot tree unavailable: ${tree.stderr}`);
    const commit = git(directory, [
      "commit-tree",
      tree.stdout.trim(),
      "-p",
      snapshot.mergeBase,
      "-m",
      "Candidate snapshot",
    ]);
    if (commit.status !== 0) return error(`scope snapshot commit failed: ${commit.stderr}`);
    for (const args of [
      ["update-ref", "HEAD", commit.stdout.trim()],
      ["read-tree", "--reset", "-u", tree.stdout.trim()],
    ]) {
      const r = git(directory, args);
      if (r.status !== 0) return error(`scope snapshot checkout failed: ${r.stderr}`);
    }
    return evaluateScopeProvenance(directory, options);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
