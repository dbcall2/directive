import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrdMarkdown } from "../render/prd-render.js";
import { renderSpecMarkdown } from "../render/spec-render.js";
import { evaluateSpecPrdFresh, runSpecPrdFreshCli } from "./spec-prd-fresh.js";

const SPEC = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    title: "Freshness Fixture",
    status: "approved",
    narratives: { Overview: "Hello freshness." },
    items: [],
  },
};

function writeSpec(root: string): string {
  const xbrief = join(root, "xbrief");
  mkdirSync(xbrief, { recursive: true });
  const specPath = join(xbrief, "specification.xbrief.json");
  writeFileSync(specPath, JSON.stringify(SPEC, null, 2), "utf8");
  return specPath;
}

describe("evaluateSpecPrdFresh", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "spec-prd-fresh-"));
    temps.push(root);
    return root;
  }

  it("exits 0 when banners and PRD projection match a fresh buffer", () => {
    const root = project();
    const specPath = writeSpec(root);
    const specRender = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: true,
    });
    expect(specRender.ok).toBe(true);
    if (!specRender.ok) return;
    writeFileSync(join(root, "SPECIFICATION.md"), specRender.markdown, "utf8");
    writeFileSync(
      join(root, "PRD.md"),
      buildPrdMarkdown("Freshness Fixture", { Overview: "Hello freshness." }, specPath),
      "utf8",
    );
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("fails banner-canon when SPECIFICATION.md still names the legacy source", () => {
    const root = project();
    const specPath = writeSpec(root);
    const specRender = renderSpecMarkdown(specPath, { includeScopes: "off" });
    expect(specRender.ok).toBe(true);
    if (!specRender.ok) return;
    const dirty = specRender.markdown.replace(
      "xbrief/specification.xbrief.json",
      "vbrief/specification.vbrief.json",
    );
    writeFileSync(join(root, "SPECIFICATION.md"), dirty, "utf8");
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.assertion === "banner-canon")).toBe(true);
  });

  it("fails projection-fresh when PRD.md body drifts from a re-render buffer", () => {
    const root = project();
    const specPath = writeSpec(root);
    const fresh = buildPrdMarkdown("Freshness Fixture", { Overview: "Hello freshness." }, specPath);
    writeFileSync(join(root, "PRD.md"), fresh.replace("Hello freshness.", "stale body"), "utf8");
    const result = evaluateSpecPrdFresh(root);
    expect(result.code).toBe(1);
    expect(
      result.findings.some((f) => f.artifact === "PRD.md" && f.assertion === "projection-fresh"),
    ).toBe(true);
  });

  it("does not recut scope outlook: prefix match is enough for SPECIFICATION.md", () => {
    const root = project();
    const specPath = writeSpec(root);
    const specRender = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: true,
    });
    expect(specRender.ok).toBe(true);
    if (!specRender.ok) return;
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      `${specRender.markdown.replace(/\n+$/u, "")}\n\n## Scope outlook\n\n### Historical dump\n`,
      "utf8",
    );
    const result = evaluateSpecPrdFresh(root);
    expect(result.findings.filter((f) => f.artifact === "SPECIFICATION.md")).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("exits 2 when --project-root is missing its argument", () => {
    const cli = runSpecPrdFreshCli(["--project-root"]);
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toContain("expected one argument");
  });
});
