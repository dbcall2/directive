import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./standards/_helpers.js";

/**
 * #4093 — package/install topology projection in docs/ARCHITECTURE.md.
 *
 * Authority: package.json files under packages/ owns membership and workspace edges;
 * `.github/workflows/npm-publish.yml` owns the observed publish sequence
 * (an ordered list, not those edges). The architecture page is a checked
 * projection. Do not treat the document as authority over manifests.
 *
 * New file: do not edit docs-orientation-current.test.ts (#4087).
 */

type WorkspacePkg = {
  dir: string;
  name: string;
  deps: string[];
};

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, { encoding: "utf8" })) as Record<string, unknown>;
}

export function readWorkspacePackages(root: string): WorkspacePkg[] {
  const packagesDir = join(root, "packages");
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const pkgs: WorkspacePkg[] = [];
  for (const dir of dirs) {
    const pkgPath = join(packagesDir, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    if (pkg.private === true) continue;
    const name = pkg.name;
    if (typeof name !== "string" || !name.startsWith("@deftai/")) {
      throw new Error(`packages/${dir}/package.json missing public @deftai name`);
    }
    const rawDeps = pkg.dependencies;
    const depNames =
      rawDeps && typeof rawDeps === "object" && !Array.isArray(rawDeps)
        ? Object.keys(rawDeps as Record<string, unknown>)
        : [];
    pkgs.push({ dir, name, deps: depNames.sort() });
  }
  return pkgs;
}

export function workspaceEdges(pkgs: WorkspacePkg[]): Array<[string, string]> {
  const names = new Set(pkgs.map((p) => p.name));
  const edges: Array<[string, string]> = [];
  for (const pkg of pkgs) {
    for (const dep of pkg.deps) {
      if (names.has(dep)) edges.push([dep, pkg.name]);
    }
  }
  return edges.sort((a, b) => `${a[0]}>${a[1]}`.localeCompare(`${b[0]}>${b[1]}`));
}

export function parsePublishSteps(yml: string): Array<{ name: string; dir: string }> {
  const steps: Array<{ name: string; dir: string }> = [];
  const parts = yml.split(/^[ \t]*- name: Publish /m);
  for (const part of parts.slice(1)) {
    const name = /^(@deftai\/[A-Za-z0-9-]+)/.exec(part)?.[1];
    const dir = /working-directory:\s*packages\/([A-Za-z0-9_-]+)/.exec(part)?.[1];
    if (name && dir) steps.push({ name, dir });
  }
  return steps;
}

export function namesMissingFromProjection(markdown: string, names: string[]): string[] {
  return names.filter((n) => !markdown.includes(n));
}

export function parseDocumentedEdges(markdown: string): Array<[string, string]> {
  const blockStart = markdown.indexOf("Workspace dependency edges");
  if (blockStart < 0) return [];
  const blockEnd = markdown.indexOf("```mermaid", blockStart);
  const block = markdown.slice(blockStart, blockEnd < 0 ? undefined : blockEnd);
  const edges: Array<[string, string]> = [];
  const re = /`(@deftai\/[^`]+)` -> `(@deftai\/[^`]+)`/g;
  for (const m of block.matchAll(re)) {
    const from = m[1];
    const to = m[2];
    if (from && to) edges.push([from, to]);
  }
  return edges.sort((a, b) => `${a[0]}>${a[1]}`.localeCompare(`${b[0]}>${b[1]}`));
}

export function parseDocumentedPublishSequence(markdown: string): string[] {
  const heading = markdown.indexOf("### Observed publish sequence");
  if (heading < 0) return [];
  const nextHeading = markdown.indexOf("\n### ", heading + 1);
  const block = markdown.slice(heading, nextHeading < 0 ? undefined : nextHeading);
  const names: string[] = [];
  const re = /^\d+\.\s+`(@deftai\/[^`]+)`/gm;
  for (const m of block.matchAll(re)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function architecture(): string {
  return readFileSync(join(repoRoot(), "docs/ARCHITECTURE.md"), { encoding: "utf8" }).replace(
    /\r\n/g,
    "\n",
  );
}

function workflowYml(): string {
  return readFileSync(join(repoRoot(), ".github/workflows/npm-publish.yml"), {
    encoding: "utf8",
  }).replace(/\r\n/g, "\n");
}

describe("architecture package topology (#4093)", () => {
  it("publish-step parser reads working-directory order from workflow YAML", () => {
    const yml = [
      "- name: Publish @deftai/directive-types",
      "  working-directory: packages/types",
      "  shell: bash",
      "- name: Publish @deftai/directive-core",
      "  extra: ignored",
      "  working-directory: packages/core",
    ].join("\n");
    expect(parsePublishSteps(yml)).toEqual([
      { name: "@deftai/directive-types", dir: "types" },
      { name: "@deftai/directive-core", dir: "core" },
    ]);
  });

  it("projection helpers detect a missing package and a dropped edge", () => {
    const names = ["@deftai/directive-types", "@deftai/directive-core"];
    expect(namesMissingFromProjection("only @deftai/directive-core", names)).toEqual([
      "@deftai/directive-types",
    ]);
    const edges = parseDocumentedEdges(
      [
        "Workspace dependency edges (from package.json):",
        "",
        "- `@deftai/directive-types` -> `@deftai/directive-core`",
        "",
        "```mermaid",
      ].join("\n"),
    );
    expect(edges).toEqual([["@deftai/directive-types", "@deftai/directive-core"]]);
  });

  it("workspace manifests are the four public @deftai packages", () => {
    const pkgs = readWorkspacePackages(repoRoot());
    expect(pkgs.map((p) => p.name).sort()).toEqual(
      [
        "@deftai/directive",
        "@deftai/directive-content",
        "@deftai/directive-core",
        "@deftai/directive-types",
      ].sort(),
    );
  });

  it("ARCHITECTURE names every published package and is not a two-package current graph", () => {
    const arch = architecture();
    const pkgs = readWorkspacePackages(repoRoot());
    expect(
      namesMissingFromProjection(
        arch,
        pkgs.map((p) => p.name),
      ),
    ).toEqual([]);
    expect(arch).not.toMatch(/two npm packages/i);
    expect(arch).toMatch(/four published/i);
  });

  it("ARCHITECTURE workspace edges match packages/*/package.json (edge ≠ publish order)", () => {
    const pkgs = readWorkspacePackages(repoRoot());
    const expected = workspaceEdges(pkgs);
    const documented = parseDocumentedEdges(architecture());
    expect(documented).toEqual(expected);
    expect(expected).toEqual([
      ["@deftai/directive-content", "@deftai/directive"],
      ["@deftai/directive-content", "@deftai/directive-core"],
      ["@deftai/directive-core", "@deftai/directive"],
      ["@deftai/directive-types", "@deftai/directive-core"],
    ]);
  });

  it("ARCHITECTURE publish sequence matches npm-publish.yml order, labeled as observed not topological", () => {
    const pkgs = readWorkspacePackages(repoRoot());
    const byDir = new Map(pkgs.map((p) => [p.dir, p.name]));
    const steps = parsePublishSteps(workflowYml());
    expect(steps.map((s) => s.dir)).toEqual(["types", "core", "content", "cli"]);
    const fromWorkflow = steps.map((s) => {
      const name = byDir.get(s.dir);
      if (!name) throw new Error(`publish step packages/${s.dir} is not a workspace package`);
      if (name !== s.name) {
        throw new Error(`publish step ${s.name} != package.json name ${name}`);
      }
      return name;
    });
    expect(parseDocumentedPublishSequence(architecture())).toEqual(fromWorkflow);
    expect(architecture()).toMatch(/not a topological sort/i);
    expect(architecture()).toMatch(/not dependency order/i);
  });

  it("TypeScript init/update is the happy-path materialization; core is not a supported library", () => {
    const arch = architecture();
    expect(arch).toMatch(/directive init/);
    expect(arch).toMatch(/directive update/);
    expect(arch).toMatch(/happy-path consumer materialization/i);
    expect(arch).toMatch(/not a supported library/i);
    expect(arch).toMatch(/supported public contract/i);
  });

  it("frozen Go is a networked GitHub-release bridge, not bundled, not deleted, not #1979", () => {
    const arch = architecture();
    expect(arch).toMatch(/frozen Go/i);
    expect(arch).toMatch(/networked/i);
    expect(arch).toMatch(/GitHub release asset/i);
    expect(arch).toMatch(/deft-install gate/);
    expect(arch).toMatch(/legacy-layout/i);
    expect(arch).toMatch(/#1979/);
    expect(arch).not.toMatch(/no longer fetches payloads/i);
    expect(arch).not.toMatch(/bundled per-platform inside the npm package/i);
    expect(arch).not.toMatch(/offline\/air-gapped/i);
  });

  it("ARCHITECTURE Node run-line does not cite .nvmrc as the consumer floor", () => {
    expect(architecture()).not.toMatch(/\.nvmrc/);
  });
});
