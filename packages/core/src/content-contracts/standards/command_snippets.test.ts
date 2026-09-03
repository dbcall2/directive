import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMAND_SNIPPET_CLASSIFICATIONS,
  COMMAND_SNIPPET_CORPUS,
  COMMAND_SNIPPET_EXEMPTIONS,
  COMMAND_SNIPPET_FROZEN_TASK_VERBS,
  COMMAND_SNIPPET_KNOWN_FALSE_TASK_VERBS,
  type CommandSnippetCorpusEntry,
  type CommandSnippetExemption,
  evaluateCommandSnippets,
  evaluateMarkdownCommandSnippets,
  extractCommandSnippets,
  formatCommandSnippetFailure,
  frameworkRepoRoot,
  loadCommandRegistries,
  readCommandSnippetCandidateDiff,
  resolveCommandSnippet,
  sameDiffExemptionViolations,
} from "../../deposit/live-procedure-targets.js";

const MAINTAINER_CURRENT: CommandSnippetCorpusEntry = {
  path: "content/commands.md",
  audience: "maintainer",
  defaultClassification: "current",
  failClosed: true,
  historicalHeadingPrefixes: ["## Command Lifecycle:", "## Historical "],
};

describe("command snippet contract (#4094)", () => {
  const repoRoot = frameworkRepoRoot();
  const registries = loadCommandRegistries(repoRoot);
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names corpus, closed classification, registry set, and audience key", () => {
    expect(COMMAND_SNIPPET_CLASSIFICATIONS).toEqual([
      "current",
      "historical",
      "frozen",
      "template",
      "illustrative",
    ]);
    const commands = COMMAND_SNIPPET_CORPUS.find((e) => e.path === "content/commands.md");
    expect(commands?.failClosed).toBe(true);
    expect(commands?.audience).toBe("maintainer");
    expect(
      COMMAND_SNIPPET_CORPUS.some((e) => e.path === "README.md" && e.failClosed === false),
    ).toBe(true);
    expect(COMMAND_SNIPPET_CORPUS.some((e) => e.path === "content/QUICK-START.md")).toBe(true);
    expect(COMMAND_SNIPPET_CORPUS.some((e) => e.path === "content/docs/getting-started.md")).toBe(
      true,
    );
    expect(registries.publicTasks.size).toBeGreaterThan(50);
    expect(registries.preferredCli.size).toBeGreaterThan(50);
    expect(registries.includeNamespaces.has("verify")).toBe(true);
  });

  it("known false task verbs are absent from the public Task graph", () => {
    for (const verb of COMMAND_SNIPPET_KNOWN_FALSE_TASK_VERBS) {
      const resolution = resolveCommandSnippet(
        {
          file: "fixture.md",
          line: 1,
          family: "task",
          verb,
          raw: `task ${verb}`,
          span: "backtick",
          classification: "current",
          audience: "maintainer",
        },
        registries,
      );
      expect(resolution.kind, verb).toBe("absent");
      expect(resolution.publicCurrent, verb).toBe(false);
    }
  });

  it("does not accept an internal Task target as a current public command", () => {
    expect(registries.internalTasks.has("engine:_ts-build")).toBe(true);
    expect(registries.publicTasks.has("engine:_ts-build")).toBe(false);
    const resolution = resolveCommandSnippet(
      {
        file: "fixture.md",
        line: 1,
        family: "task",
        verb: "engine:_ts-build",
        raw: "task engine:_ts-build",
        span: "backtick",
        classification: "current",
        audience: "maintainer",
      },
      registries,
    );
    expect(resolution.kind).toBe("taskfile-internal");
    expect(resolution.publicCurrent).toBe(false);
  });

  it("CLI current snippets use preferred/help names, not deferred or alias-only stems", () => {
    expect(
      resolveCommandSnippet(
        {
          file: "fixture.md",
          line: 1,
          family: "cli",
          verb: "policy:allow-bot-merge",
          raw: "deft policy:allow-bot-merge",
          span: "backtick",
          classification: "current",
          audience: "maintainer",
        },
        registries,
      ).publicCurrent,
    ).toBe(true);
    expect(
      resolveCommandSnippet(
        {
          file: "fixture.md",
          line: 1,
          family: "cli",
          verb: "feature",
          raw: "deft feature",
          span: "backtick",
          classification: "current",
          audience: "maintainer",
        },
        registries,
      ).kind,
    ).toBe("cli-deferred");
    expect(
      resolveCommandSnippet(
        {
          file: "fixture.md",
          line: 1,
          family: "cli",
          verb: "validate-links",
          raw: "deft validate-links",
          span: "backtick",
          classification: "current",
          audience: "maintainer",
        },
        registries,
      ).publicCurrent,
    ).toBe(false);
  });

  it("looks up verb/namespace only and skips globs, flags, and bare namespaces", () => {
    const text = [
      "`task --list`",
      "`task architecture:*`",
      "`task policy`",
      "`task check`",
      "`task verify:branch -- --allow-dirty`",
    ].join("\n");
    const snippets = extractCommandSnippets(text, "fixture.md", MAINTAINER_CURRENT);
    const verbs = snippets.map((s) => s.verb).sort();
    expect(verbs).toEqual(["check", "policy", "verify:branch"]);
    const policy = snippets.find((s) => s.verb === "policy");
    expect(policy).toBeDefined();
    if (policy === undefined) return;
    expect(resolveCommandSnippet(policy, registries).kind).toBe("skipped");
  });

  it("extracts the verb after runner flags that follow the launcher", () => {
    const text = [
      "`task -t Taskfile.yml check:slow`",
      "`task --verbose check`",
      "`FOO=1 task -d . verify:branch`",
    ].join("\n");
    const snippets = extractCommandSnippets(text, "fixture.md", MAINTAINER_CURRENT);
    expect(snippets.map((s) => s.verb).sort()).toEqual(["check", "check:slow", "verify:branch"]);
    const gated = evaluateMarkdownCommandSnippets({
      text: "`task -t Taskfile.yml check:slow`\n",
      file: "content/commands.md",
      entry: MAINTAINER_CURRENT,
      registries,
    });
    expect(gated.findings.some((f) => f.snippet.verb === "check:slow")).toBe(true);
  });

  it("does not execute extracted fences", () => {
    const root = mkdtempSync(join(tmpdir(), "cmd-snippet-fence-"));
    created.push(root);
    const marker = join(root, "pwned");
    const text = ["```bash", `touch ${marker}`, "task check:slow", "```"].join("\n");
    const result = evaluateMarkdownCommandSnippets({
      text,
      file: "fixture.md",
      entry: MAINTAINER_CURRENT,
      registries,
    });
    expect(existsSync(marker)).toBe(false);
    expect(result.findings.some((f) => f.snippet.verb === "check:slow")).toBe(true);
  });

  it("classifies historical headings and frozen verbs instead of rewriting them", () => {
    const text = [
      "`task check`",
      "`task migrate:vbrief`",
      "## Command Lifecycle: retired Python launcher vs `task`",
      "`task doctor`",
    ].join("\n");
    const snippets = extractCommandSnippets(text, "content/commands.md", MAINTAINER_CURRENT);
    expect(COMMAND_SNIPPET_FROZEN_TASK_VERBS.has("migrate:vbrief")).toBe(true);
    expect(snippets.find((s) => s.verb === "migrate:vbrief")?.classification).toBe("frozen");
    expect(snippets.find((s) => s.verb === "doctor" && s.family === "task")?.classification).toBe(
      "historical",
    );
    expect(snippets.find((s) => s.verb === "check")?.classification).toBe("current");
  });

  it("resets historical classification on a later current heading", () => {
    const text = [
      "`task check`",
      "## Command Lifecycle: retired Python launcher vs `task`",
      "`task doctor`",
      "## Anti-Patterns",
      "`task check`",
      "`task check:slow`",
    ].join("\n");
    const snippets = extractCommandSnippets(text, "content/commands.md", MAINTAINER_CURRENT);
    const slow = snippets.find((s) => s.verb === "check:slow");
    expect(slow?.classification).toBe("current");
    const result = evaluateMarkdownCommandSnippets({
      text,
      file: "content/commands.md",
      entry: MAINTAINER_CURRENT,
      registries,
    });
    expect(result.findings.some((f) => f.snippet.verb === "check:slow")).toBe(true);
  });

  it("fails a current snippet that names a retired verb", () => {
    const result = evaluateMarkdownCommandSnippets({
      text: "Run `task check:slow` now.\n",
      file: "content/commands.md",
      entry: MAINTAINER_CURRENT,
      registries,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.snippet.verb).toBe("check:slow");
    expect(formatCommandSnippetFailure(result)).toContain("check:slow");
  });

  it("same-diff exemption additions fail; exemption-only diffs do not", () => {
    const sameDiff = [
      "diff --git a/packages/core/src/deposit/live-procedure-targets.ts b/packages/core/src/deposit/live-procedure-targets.ts",
      "--- a/packages/core/src/deposit/live-procedure-targets.ts",
      "+++ b/packages/core/src/deposit/live-procedure-targets.ts",
      "@@ -1,0 +1,6 @@",
      "+  {",
      '+    family: "task",',
      '+    verb: "check:slow",',
      '+    path: "content/commands.md",',
      '+    classification: "illustrative",',
      '+    reason: "waive",',
      "+  },",
      "diff --git a/content/commands.md b/content/commands.md",
      "--- a/content/commands.md",
      "+++ b/content/commands.md",
      "@@ -1,0 +1,1 @@",
      "+- `task check:slow` -- slower/full checks.",
    ].join("\n");
    expect(sameDiffExemptionViolations(sameDiff)).toEqual([
      { verb: "check:slow", path: "content/commands.md", family: "task" },
    ]);

    const exemptionOnly = [
      "diff --git a/packages/core/src/deposit/live-procedure-targets.ts b/packages/core/src/deposit/live-procedure-targets.ts",
      "--- a/packages/core/src/deposit/live-procedure-targets.ts",
      "+++ b/packages/core/src/deposit/live-procedure-targets.ts",
      "@@ -1,0 +1,6 @@",
      "+  {",
      '+    family: "task",',
      '+    verb: "migrate:vbrief",',
      '+    path: "content/commands.md",',
      '+    classification: "frozen",',
      '+    reason: "pinned v0.59.0",',
      "+  },",
    ].join("\n");
    expect(sameDiffExemptionViolations(exemptionOnly)).toEqual([]);
    const gated = evaluateCommandSnippets({
      repoRoot,
      corpus: [MAINTAINER_CURRENT],
      diffText: sameDiff,
    });
    expect(gated.findings.some((f) => f.snippet.raw.includes("same-diff exemption"))).toBe(true);
  });

  it("same-diff keeps the newest git log -p patch instead of the oldest overwrite", () => {
    const newestFirstLog = [
      "commit 111newest",
      "Author: test",
      "",
      "    add exemption and snippet",
      "",
      "diff --git a/packages/core/src/deposit/live-procedure-targets.ts b/packages/core/src/deposit/live-procedure-targets.ts",
      "--- a/packages/core/src/deposit/live-procedure-targets.ts",
      "+++ b/packages/core/src/deposit/live-procedure-targets.ts",
      "@@ -1,0 +1,6 @@",
      "+  {",
      '+    family: "task",',
      '+    verb: "check:slow",',
      '+    path: "content/commands.md",',
      '+    classification: "illustrative",',
      '+    reason: "waive",',
      "+  },",
      "diff --git a/content/commands.md b/content/commands.md",
      "--- a/content/commands.md",
      "+++ b/content/commands.md",
      "@@ -1,0 +1,1 @@",
      "+- `task check:slow` -- slower/full checks.",
      "commit 000oldest",
      "Author: test",
      "",
      "    earlier unrelated edit",
      "",
      "diff --git a/packages/core/src/deposit/live-procedure-targets.ts b/packages/core/src/deposit/live-procedure-targets.ts",
      "--- a/packages/core/src/deposit/live-procedure-targets.ts",
      "+++ b/packages/core/src/deposit/live-procedure-targets.ts",
      "@@ -1,0 +1,1 @@",
      "+export const unrelated = true;",
      "diff --git a/content/commands.md b/content/commands.md",
      "--- a/content/commands.md",
      "+++ b/content/commands.md",
      "@@ -1,0 +1,1 @@",
      "+# Commands",
    ].join("\n");
    expect(sameDiffExemptionViolations(newestFirstLog)).toEqual([
      { verb: "check:slow", path: "content/commands.md", family: "task" },
    ]);
  });

  it("does not rewrite Taskfile descriptions as a side effect", () => {
    const taskfile = join(repoRoot, "Taskfile.yml");
    const before = createHash("sha256").update(readFileSync(taskfile)).digest("hex");
    evaluateCommandSnippets({ repoRoot, corpus: [MAINTAINER_CURRENT] });
    const after = createHash("sha256").update(readFileSync(taskfile)).digest("hex");
    expect(after).toBe(before);
    expect(COMMAND_SNIPPET_EXEMPTIONS).toEqual([]);
  });

  it("candidate diff is non-empty so same-diff cannot vanish in git checkouts", () => {
    const diff = readCommandSnippetCandidateDiff(repoRoot);
    expect(diff.includes("diff --git")).toBe(true);
  });

  it("fail-closed commands.md current snippets resolve on the named registries", () => {
    const result = evaluateCommandSnippets({ repoRoot, corpus: [MAINTAINER_CURRENT] });
    expect(result.snippets.length).toBeGreaterThan(20);
    expect(result.snippets.some((s) => s.span === "backtick")).toBe(true);
    expect(result.findings, formatCommandSnippetFailure(result)).toEqual([]);
    expect(result.snippets.some((s) => s.classification === "current" && s.verb === "check")).toBe(
      true,
    );
    expect(
      result.snippets.some((s) => s.verb === "check:slow" && s.classification === "current"),
    ).toBe(false);
    expect(
      result.snippets.some(
        (s) => s.verb === "verify:xbrief-conformance" && s.classification === "current",
      ),
    ).toBe(false);
  });

  it("applies a typed exemption without executing or rewriting the verb", () => {
    const exemptions: readonly CommandSnippetExemption[] = [
      {
        family: "task",
        verb: "triage:foo",
        path: "content/commands.md",
        classification: "illustrative",
        reason: "placeholder in a fixture",
      },
    ];
    const result = evaluateMarkdownCommandSnippets({
      text: "Example: `task triage:foo`\n",
      file: "content/commands.md",
      entry: MAINTAINER_CURRENT,
      registries,
      exemptions,
    });
    expect(result.findings).toEqual([]);
    expect(result.snippets[0]?.classification).toBe("illustrative");
    expect(result.snippets[0]?.verb).toBe("triage:foo");
  });
});
