import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveSpecArtifactPath } from "../layout/resolve.js";
import { buildPrdBanner, buildSpecRenderBanner } from "../render/constants.js";
import { buildPrdMarkdown } from "../render/prd-render.js";
import { renderSpecMarkdown } from "../render/spec-render.js";

export interface SpecPrdFreshFinding {
  readonly artifact: "SPECIFICATION.md" | "PRD.md";
  readonly assertion: "banner-canon" | "projection-fresh";
  readonly detail: string;
}

export interface SpecPrdFreshResult {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly SpecPrdFreshFinding[];
  readonly message: string;
}

function readText(path: string): string | { error: string } {
  try {
    return readFileSync(path, { encoding: "utf8" }).replace(/\r\n/g, "\n");
  } catch (err) {
    return { error: String(err) };
  }
}

function bannerBlock(banner: string): string {
  return banner.replace(/\n$/u, "");
}

function committedBanner(content: string): string {
  return content.split("\n").slice(0, 4).join("\n");
}

/** Drop `## LegacyArtifacts` so the gate matches compact `task spec:render` (#1566 / #4086). */
function stripLegacyArtifactsSection(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping) {
      if (line === "## LegacyArtifacts" || line.startsWith("## LegacyArtifacts ")) {
        skipping = true;
        continue;
      }
      out.push(line);
      continue;
    }
    if (line.startsWith("## ")) {
      skipping = false;
      out.push(line);
    }
  }
  return out.join("\n");
}

function specProductPrefix(content: string): string {
  const withoutLegacy = stripLegacyArtifactsSection(content);
  const marker = "\n## Scope outlook";
  const idx = withoutLegacy.indexOf(marker);
  const prefix = idx === -1 ? withoutLegacy : withoutLegacy.slice(0, idx);
  return `${prefix.replace(/[ \t]+$/gmu, "").replace(/\n+$/u, "")}\n`;
}

function loadTitleAndNarratives(sourcePath: string): {
  title: string;
  narratives: Record<string, unknown>;
} {
  const payload: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { title: "Project", narratives: {} };
  }
  const data = payload as Record<string, unknown>;
  const plan =
    typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
      ? (data.plan as Record<string, unknown>)
      : {};
  const narratives =
    typeof plan.narratives === "object" &&
    plan.narratives !== null &&
    !Array.isArray(plan.narratives)
      ? (plan.narratives as Record<string, unknown>)
      : {};
  return { title: String(plan.title ?? "Project"), narratives };
}

/** Fail-closed SPECIFICATION.md / PRD.md freshness (#4086). Banner canon and projection are separate. */
export function evaluateSpecPrdFresh(projectRoot: string): SpecPrdFreshResult {
  const root = resolve(projectRoot);
  let specPath: string;
  try {
    specPath = resolveSpecArtifactPath(root);
  } catch (err) {
    return {
      code: 2,
      findings: [],
      message:
        `verify_spec_prd_fresh: cannot resolve specification source: ${err instanceof Error ? err.message : String(err)}\n` +
        "  Recovery: run `deft migrate:xbrief` or pass a project with `xbrief/specification.xbrief.json`.",
    };
  }
  if (!existsSync(specPath)) {
    return {
      code: 2,
      findings: [],
      message:
        `verify_spec_prd_fresh: specification source missing: ${specPath}\n` +
        "  Recovery: restore `xbrief/specification.xbrief.json`.",
    };
  }

  const findings: SpecPrdFreshFinding[] = [];
  const expectedSpecBanner = bannerBlock(buildSpecRenderBanner(specPath));
  const expectedPrdBanner = bannerBlock(buildPrdBanner(specPath));

  const specMdPath = join(root, "SPECIFICATION.md");
  if (existsSync(specMdPath)) {
    const committed = readText(specMdPath);
    if (typeof committed !== "string") {
      return {
        code: 2,
        findings: [],
        message: `verify_spec_prd_fresh: SPECIFICATION.md unreadable: ${committed.error}`,
      };
    }
    if (committedBanner(committed) !== expectedSpecBanner) {
      findings.push({
        artifact: "SPECIFICATION.md",
        assertion: "banner-canon",
        detail:
          "banner does not match `buildGeneratedArtifactBanner` from the resolved specification path; run `task spec:render` or restore the four-line banner",
      });
    }
    const rendered = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: false,
    });
    if (!rendered.ok) {
      findings.push({
        artifact: "SPECIFICATION.md",
        assertion: "projection-fresh",
        detail: `re-render failed: ${rendered.message}`,
      });
    } else if (committed.includes("\n## Scope outlook")) {
      // Full spec projection (scope outlook) belongs to #1567. Re-render the
      // compact product-narrative buffer and compare the committed prefix.
      const expectedPrefix = specProductPrefix(rendered.markdown);
      const committedPrefix = specProductPrefix(committed);
      if (expectedPrefix !== committedPrefix) {
        findings.push({
          artifact: "SPECIFICATION.md",
          assertion: "projection-fresh",
          detail:
            "product-narrative prefix is stale versus a compact `task spec:render` buffer (scope outlook is owned by #1567 and is not compared)",
        });
      }
    } else if (specProductPrefix(rendered.markdown) !== specProductPrefix(committed)) {
      findings.push({
        artifact: "SPECIFICATION.md",
        assertion: "projection-fresh",
        detail:
          "SPECIFICATION.md differs from a fresh compact render buffer; run `task spec:render`",
      });
    }
  }

  const prdMdPath = join(root, "PRD.md");
  if (existsSync(prdMdPath)) {
    const committed = readText(prdMdPath);
    if (typeof committed !== "string") {
      return {
        code: 2,
        findings: [],
        message: `verify_spec_prd_fresh: PRD.md unreadable: ${committed.error}`,
      };
    }
    if (committedBanner(committed) !== expectedPrdBanner) {
      findings.push({
        artifact: "PRD.md",
        assertion: "banner-canon",
        detail:
          "banner does not match `buildGeneratedArtifactBanner` from the resolved specification path; run `task prd:render`",
      });
    }
    const { title, narratives } = loadTitleAndNarratives(specPath);
    const expectedPrd = buildPrdMarkdown(title, narratives, specPath);
    if (expectedPrd !== committed) {
      findings.push({
        artifact: "PRD.md",
        assertion: "projection-fresh",
        detail: "PRD.md differs from a fresh `task prd:render` buffer; run `task prd:render`",
      });
    }
  }

  if (findings.length > 0) {
    const body = findings.map((f) => `  ${f.artifact} [${f.assertion}] ${f.detail}`).join("\n");
    return {
      code: 1,
      findings,
      message:
        `verify_spec_prd_fresh: ${findings.length} generated-view freshness error(s) (#4086).\n` +
        "  Banner canon and full projection freshness are separate assertions.\n" +
        `${body}\n` +
        "  Recovery: restore banners via `buildGeneratedArtifactBanner` from the resolved path; re-render PRD.md; do not recut SPECIFICATION.md scope outlook (#1567).",
    };
  }
  return {
    code: 0,
    findings: [],
    message:
      "verify_spec_prd_fresh: SPECIFICATION.md and PRD.md banners and projections are fresh (#4086).",
  };
}

export interface SpecPrdFreshCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSpecPrdFreshCli(argv: string[]): SpecPrdFreshCliResult {
  let projectRoot = ".";
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "verify_spec_prd_fresh: argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--quiet") {
      quiet = true;
    } else {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `verify_spec_prd_fresh: unrecognized argument: ${arg}\n`,
      };
    }
  }
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);
  const result = evaluateSpecPrdFresh(root);
  if (result.code === 0) {
    return { exitCode: 0, stdout: quiet ? "" : `${result.message}\n`, stderr: "" };
  }
  return { exitCode: result.code, stdout: "", stderr: `${result.message}\n` };
}
