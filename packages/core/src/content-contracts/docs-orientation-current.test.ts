import { describe, expect, it } from "vitest";
import { readText } from "./standards/_helpers.js";

/**
 * #4087 Wave 1a — content-contract over labeled-current trees in
 * docs/ARCHITECTURE.md and docs/CONCEPTS.md (same family as branch_gate.test.ts).
 *
 * Enforcement: FAIL-CLOSED. This vitest is in the packages/core check graph.
 * Covered surfaces: docs/ARCHITECTURE.md and docs/CONCEPTS.md only.
 * Relationship to #514: does not take #514's markdown-link allowlist. This pin
 * is a separate current-tense retired-launcher check over labeled-current
 * prose in the two orientation files this slice owns.
 * Allowlist: none. An allowlist addition in the same diff as the path it
 * exempts is forbidden by the #4087 recut.
 * Does not generate FILES.md. Does not reimplement C3.
 * Read-only against the tree under test (this worktree), not origin/master.
 */

const COVERED = ["docs/ARCHITECTURE.md", "docs/CONCEPTS.md"] as const;

const HISTORICAL =
  /historical|legacy|retired|no longer|python\/run era|removed from the current tree|not current|not the current/i;

const RETIRED_LAUNCHER =
  /run\.py|run\.bat|preflight_branch\.py|scripts\/\*\.py|scripts\/[A-Za-z0-9_.-]+\.py|Python tooling/;

/** Hits in labeled-current (non-historical) lines. */
function retiredLauncherHits(markdown: string, rel: string): string[] {
  const hits: string[] = [];
  const lines = markdown.split("\n");
  let skipHeading = false;
  let skipHeadingLevel = 0;
  let skipQuote = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2] ?? "";
      if (HISTORICAL.test(title)) {
        skipHeading = true;
        skipHeadingLevel = level;
        continue;
      }
      if (skipHeading && level <= skipHeadingLevel) {
        skipHeading = false;
      }
    }
    if (line.startsWith(">")) {
      if (HISTORICAL.test(line) || skipQuote) {
        skipQuote = true;
        continue;
      }
    } else {
      skipQuote = false;
    }
    if (skipHeading) continue;
    if (HISTORICAL.test(line)) continue;
    if (RETIRED_LAUNCHER.test(line)) {
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  }
  return hits;
}

describe("docs orientation current-tense (#4087 Wave 1a) — FAIL-CLOSED", () => {
  it("unlabeled run.py in labeled-current prose is a hit", () => {
    expect(
      retiredLauncherHits("The launcher is `run.py`.\n", "docs/ARCHITECTURE.md").length,
    ).toBeGreaterThan(0);
  });

  it("historical-labeled run.py is not a hit", () => {
    expect(
      retiredLauncherHits(
        "> **Historical (Python/run era):** `run.py` and `run.bat`\n",
        "docs/ARCHITECTURE.md",
      ),
    ).toEqual([]);
  });

  it("covered orientation files exist", () => {
    for (const rel of COVERED) {
      expect(readText(rel).length).toBeGreaterThan(0);
    }
  });

  it("labeled-current ARCHITECTURE and CONCEPTS do not name retired Python launchers", () => {
    const hits: string[] = [];
    for (const rel of COVERED) {
      hits.push(...retiredLauncherHits(readText(rel), rel));
    }
    expect(hits).toEqual([]);
  });

  it("CONCEPTS MAP status claims rendering is shipped", () => {
    const concepts = readText("docs/CONCEPTS.md");
    expect(concepts).toMatch(/MAP rendering:\s*shipped/i);
    expect(concepts).not.toMatch(/MAP rendering:\s*planned/i);
  });

  it("ARCHITECTURE names runtime, Taskfile facade, consumer CLI, and hook entrypoints as separate lanes", () => {
    const arch = readText("docs/ARCHITECTURE.md");
    expect(arch).toMatch(/TypeScript packages/i);
    expect(arch).toMatch(/implementation and runtime owner/i);
    expect(arch).toMatch(/repository command facade/i);
    expect(arch).toMatch(/`deft`\s*\/\s*`directive`/);
    expect(arch).toMatch(/installed consumer CLI/i);
    expect(arch).toMatch(/deft-hook/);
    expect(arch).toMatch(/Git-hook/i);
  });
});
