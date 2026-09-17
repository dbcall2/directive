import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

/**
 * Wave 1 policy lock (#4316 / parent #4164). Invert of closed unmerged PR 4196.
 *
 * GitHub merge protection is the TypeScript aggregator, not FRAMEWORK_CHECK_GATES.
 * A later worker can recouple leftover-complete to ROADMAP without putting
 * roadmap:check on the Taskfile lists — this suite scan is that lock.
 * Fixture-level checkDrift against a temp outPath stays legal (AC 1).
 */
const LOCK_BASENAME = "roadmap_merge_lane_lock.test.ts";

function collectVitestSuiteFiles(dir: string, acc: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist") {
      continue;
    }
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectVitestSuiteFiles(abs, acc);
      continue;
    }
    if (ent.name.endsWith(".test.ts")) {
      acc.push(abs);
    }
  }
}

function requiredVitestSuite(): string[] {
  const root = repoRoot();
  const packagesDir = join(root, "packages");
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) {
      continue;
    }
    const src = join(packagesDir, pkg.name, "src");
    try {
      collectVitestSuiteFiles(src, files);
    } catch {
      /* package has no src/ */
    }
  }
  return files.sort();
}

function liveCheckoutRoadmapHits(source: string, rel: string): string[] {
  const hits: string[] = [];
  // 4196 exemplar: roadmapRenderMain(["--project-root", REPO_ROOT, "--check"])
  const liveMainCheck =
    /roadmapRenderMain\s*\(\s*\[[^\]]*(?:REPO_ROOT|repoRoot\(\))[^\]]*--check/.test(source) ||
    /roadmapRenderMain\s*\(\s*\[[^\]]*--check[^\]]*(?:REPO_ROOT|repoRoot\(\))/.test(source);
  if (liveMainCheck) {
    hits.push(`${rel}: live-repo roadmapRenderMain --check`);
  }
  if (
    /checkDrift\s*\(/.test(source) &&
    /join\s*\(\s*(?:REPO_ROOT|repoRoot\(\))\s*,\s*["']ROADMAP\.md["']/.test(source)
  ) {
    hits.push(`${rel}: checkDrift against checkout ROADMAP.md`);
  }
  if (/\btask\s+roadmap:check\b/.test(source)) {
    hits.push(`${rel}: task roadmap:check from a test`);
  }
  if (/\b(?:execFileSync|execSync|spawnSync|spawn)\b[\s\S]{0,400}roadmap:check/.test(source)) {
    hits.push(`${rel}: spawned roadmap:check`);
  }
  return hits;
}

describe("ROADMAP merge-lane lock (#4316)", () => {
  it("required vitest suite has no live-checkout ROADMAP freshness assertion", () => {
    const root = repoRoot();
    const hits: string[] = [];
    for (const abs of requiredVitestSuite()) {
      const rel = relative(root, abs).split("\\").join("/");
      if (rel.endsWith(LOCK_BASENAME)) {
        continue;
      }
      const source = readFileSync(abs, "utf8");
      hits.push(...liveCheckoutRoadmapHits(source, rel));
    }
    expect(hits).toEqual([]);
  });

  it("named producer files do not write or require ROADMAP.md", () => {
    const root = repoRoot();
    const files = [
      "packages/core/src/scope/transition.ts",
      "packages/core/src/swarm/finalize-cohort.ts",
      "packages/core/src/swarm/complete-cohort.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(join(root, rel), "utf8");
      expect(src, rel).not.toContain("syncRoadmapAfterCompletedSetChange");
      expect(src, rel).not.toContain("roadmap-render");
      expect(src, rel).not.toMatch(/ROADMAP\.md/);
      expect(src, rel).not.toContain("refreshRoadmapNative");
    }
  });

  it("refreshRoadmapNative remains the sole automatic ROADMAP producer", () => {
    const native = readFileSync(
      join(repoRoot(), "packages/core/src/release/native-steps.ts"),
      "utf8",
    );
    expect(native).toContain("export function refreshRoadmapNative");
    expect(native).toMatch(/renderRoadmap\(/);
    const renderer = readFileSync(
      join(repoRoot(), "packages/core/src/render/roadmap-render.ts"),
      "utf8",
    );
    expect(renderer).not.toContain("syncRoadmapAfterCompletedSetChange");
  });

  it("does not add verify:roadmap-policy", () => {
    const taskfile = readFileSync(join(repoRoot(), "Taskfile.yml"), "utf8");
    const gates = readFileSync(join(repoRoot(), "packages/core/src/check/gate-lists.ts"), "utf8");
    expect(taskfile).not.toContain("verify:roadmap-policy");
    expect(gates).not.toContain("verify:roadmap-policy");
  });

  it("issue-closing PR template does not ask for a ROADMAP.md edit", () => {
    const template = readText(".github/PULL_REQUEST_TEMPLATE.md");
    expect(template).not.toMatch(/updated if this closes a tracked issue/);
    expect(template).not.toMatch(/ROADMAP\.md[^\n]*leftover/i);
  });
});
