import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile } from "./helpers.js";

/**
 * #3664 R2 — mechanized scan of agent-runnable `gh auth status` instructions.
 * Prohibitions stay. Descriptions may mention the command. Imperatives fail.
 * Banning every occurrence of the string is a miss.
 */

export type GhAuthStatusLineClass = "prohibition" | "description" | "imperative";

export function classifyGhAuthStatusLine(line: string): GhAuthStatusLineClass | null {
  if (!line.includes("gh auth status")) {
    return null;
  }
  const body = line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)+/, "");
  if (body.startsWith("⊗")) {
    return "prohibition";
  }
  if (
    /host's `gh auth status`/.test(line) ||
    /`gh auth status` token/.test(line) ||
    /parent-shell `gh auth status`/.test(line)
  ) {
    return "description";
  }
  if (
    /`gh auth status` must (?:pass|succeed)/.test(line) ||
    /gh auth status` reports authenticated/.test(line) ||
    /Verify `gh` is authenticated:\s*`gh auth status`/.test(line) ||
    /check gh auth status/.test(line) ||
    /verify gh auth status/.test(line) ||
    /requires `gh auth status`/.test(line) ||
    /!\s+Verify `gh auth status`/.test(line) ||
    /!\s+(?:Run|Execute|Invoke|Call)\s+`gh auth status`/.test(line) ||
    /\b(?:Run|Execute|Invoke|Call) `gh auth status`/.test(line)
  ) {
    return "imperative";
  }
  return "description";
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly klass: GhAuthStatusLineClass;
  readonly text: string;
}

function walkFiles(root: string, acc: string[]): void {
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === ".git" || name === "dist") {
      continue;
    }
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, acc);
      continue;
    }
    if (/\.(md|json|ts|yml)$/.test(name)) {
      acc.push(full);
    }
  }
}

function scanFile(abs: string): Hit[] {
  const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
  const text = readFileSync(abs, "utf8");
  const hits: Hit[] = [];
  for (const [idx, line] of text.split("\n").entries()) {
    const klass = classifyGhAuthStatusLine(line);
    if (klass === null) {
      continue;
    }
    hits.push({ file: rel, line: idx + 1, klass, text: line.trim() });
  }
  return hits;
}

function collectHits(): Hit[] {
  const files: string[] = [];
  walkFiles(join(REPO_ROOT, "content"), files);
  files.push(join(REPO_ROOT, "docs", "subagent-heartbeat.md"));
  files.push(join(REPO_ROOT, "packages", "core", "src", "scm", "gh-rest.ts"));
  files.push(join(REPO_ROOT, "packages", "core", "src", "intake", "github-auth-modes.ts"));
  const hits: Hit[] = [];
  for (const file of files) {
    hits.push(...scanFile(file));
  }
  return hits;
}

describe("gh auth status instruction class (#3664 R2)", () => {
  it("classifies prohibition, description, and imperative fixtures", () => {
    expect(
      classifyGhAuthStatusLine("⊗ Assume parent-shell `gh auth status` proves readiness"),
    ).toBe("prohibition");
    expect(
      classifyGhAuthStatusLine(
        "- ! FAIL LOUD -- do not silently run under the host's `gh auth status` token.",
      ),
    ).toBe("description");
    expect(classifyGhAuthStatusLine("Shallow probe: short `gh auth status`.")).toBe("description");
    expect(
      classifyGhAuthStatusLine(
        "- ! Verify `gh` is authenticated: `gh auth status` — stop and report if not",
      ),
    ).toBe("imperative");
    expect(classifyGhAuthStatusLine("- ! Still verify identity: `gh auth status` must pass.")).toBe(
      "imperative",
    );
    expect(classifyGhAuthStatusLine('hint: "check gh auth status"')).toBe("imperative");
    expect(classifyGhAuthStatusLine("! Run `gh auth status` before filing")).toBe("imperative");
    expect(classifyGhAuthStatusLine("no mention")).toBeNull();
  });

  it("keeps prohibition and description mentions; fails closed on imperatives", () => {
    const hits = collectHits();
    const prohibitions = hits.filter((h) => h.klass === "prohibition");
    const descriptions = hits.filter((h) => h.klass === "description");
    const imperatives = hits.filter((h) => h.klass === "imperative");
    expect(prohibitions.length).toBeGreaterThan(0);
    expect(descriptions.length).toBeGreaterThan(0);
    const detail = imperatives.map((h) => `  ${h.file}:${h.line} ${h.text}`).join("\n");
    expect(imperatives, `agent-runnable gh auth status instructions remain:\n${detail}`).toEqual(
      [],
    );
  });

  it("does not ban every occurrence of the string", () => {
    const commands = readRepoFile("commands.md");
    expect(commands).toContain("gh auth status");
    const ops = readRepoFile("skills/deft-directive-swarm/references/core-ops.md");
    expect(ops).toContain("gh auth status");
  });
});
