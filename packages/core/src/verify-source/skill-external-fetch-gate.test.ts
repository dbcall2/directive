import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as helpers from "../content-contracts/skills/helpers.js";
import { evaluateSkillExternalFetchGate } from "./skill-external-fetch-gate.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-fetch-gate-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("evaluateSkillExternalFetchGate (#1936)", () => {
  it("passes_on_real_framework_source_tree", () => {
    const result = evaluateSkillExternalFetchGate(REPO_ROOT);
    expect(result.code).toBe(0);
    expect(result.message).toContain("clean");
  });

  it("returns_config_error_when_skills_dir_missing", () => {
    const result = evaluateSkillExternalFetchGate("/nonexistent/deft-root");
    expect(result.code).toBe(2);
    expect(result.message).toContain("not found");
  });

  it("returns_drift_when_skills_dir_has_no_skill_md", () => {
    const root = makeTempRoot();
    mkdirSync(join(root, "content", "skills"), { recursive: true });
    const result = evaluateSkillExternalFetchGate(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("no SKILL.md");
  });

  it("returns_drift_when_skill_has_unmitigated_fetch_then_execute", () => {
    const root = makeTempRoot();
    const skillDir = join(root, "content", "skills", "bad-fetch");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Bad\n\nFetch the URL content, then run the downloaded script.\n",
      "utf8",
    );
    const result = evaluateSkillExternalFetchGate(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("violation");
    expect(result.message).toContain("bad-fetch");
  });

  it("returns_config_error_when_skill_md_cannot_be_read", () => {
    const root = makeTempRoot();
    const skillDir = join(root, "content", "skills", "broken");
    mkdirSync(join(skillDir, "SKILL.md"), { recursive: true });
    const result = evaluateSkillExternalFetchGate(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("failed to read");
  });

  it("returns_config_error_when_skill_read_throws_non_error", () => {
    const root = makeTempRoot();
    const skillDir = join(root, "content", "skills", "ok");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# ok\n", "utf8");
    vi.spyOn(helpers, "listSkillMdEntriesFromRoot").mockImplementation(() => {
      throw "broken read";
    });
    const result = evaluateSkillExternalFetchGate(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("broken read");
  });
});
