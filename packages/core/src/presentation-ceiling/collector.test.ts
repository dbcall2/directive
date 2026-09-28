import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePresentationCeiling } from "./evaluate.js";

const CEILING = ".deft/presentation-ceiling.json";
const RECORD = ".deft/approved-scope/story.json";
const roots: string[] = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ceiling-5056-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  for (const [path, text] of Object.entries(files)) write(path, text);
  const commit = () => {
    git("add", "-A");
    git("commit", "-m", "fixture");
  };
  commit();
  git("checkout", "-b", "feature");
  return {
    root,
    git,
    write,
    commit,
    run: (baseRef = "main") => evaluatePresentationCeiling(root, { baseRef }),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ceiling = JSON.stringify({ changeClass: "presentation" });

describe("presentation ceiling real Git collector", () => {
  it("keeps a ceiling removed from the target after the fork", () => {
    const f = fixture({ [CEILING]: ceiling });
    f.write("db/save.sql", "INSERT INTO items VALUES (1)");
    f.commit();
    f.git("checkout", "main");
    f.git("rm", CEILING);
    f.commit();
    f.git("checkout", "feature");
    expect(f.run().exitCode).toBe(1);
    expect(f.run().armed).toBe(true);
  });
  it("does not acquire a ceiling added to the target after the fork", () => {
    const f = fixture({ "README.md": "project" });
    f.write("db/save.sql", "INSERT INTO items VALUES (1)");
    f.commit();
    f.git("checkout", "main");
    f.write(CEILING, ceiling);
    f.commit();
    f.git("checkout", "feature");
    expect(f.run()).toMatchObject({ exitCode: 0, armed: false });
  });
  it("treats valid regex characters in refs literally", () => {
    const f = fixture({
      [CEILING]: ceiling,
      "src/reader.js": "readFileSync('CHANGELOG.md')",
      "CHANGELOG.md": "old",
    });
    f.git("branch", "topic(foo");
    f.write("CHANGELOG.md", "new");
    expect(f.run("topic(foo").exitCode).toBe(1);
  });
  it("returns configuration failure for an invalid ref", () => {
    const f = fixture({ [CEILING]: ceiling });
    expect(f.run("missing").exitCode).toBe(2);
  });
  it("accepts ordinary prose and code comments mentioning CHANGELOG", () => {
    const f = fixture({
      [CEILING]: ceiling,
      "AGENTS.md": "Update CHANGELOG.md",
      "README.md": "Read CHANGELOG.md",
      "src/app.js": "// readFileSync('CHANGELOG.md')\nexport const label = 'update CHANGELOG.md';",
      "CHANGELOG.md": "old",
    });
    f.write("CHANGELOG.md", "release notes");
    expect(f.run().exitCode).toBe(0);
  });
  it.each([
    "js",
    "tsx",
    "html",
    "py",
  ])("rejects unchanged %s executable changelog readers", (ext) => {
    const readers: Record<string, string> = {
      js: "readFileSync('CHANGELOG.md')",
      tsx: "export const data = readFileSync('CHANGELOG.md');",
      html: "<script>fetch('CHANGELOG.md')</script>",
      py: "data = open('CHANGELOG.md').read()",
    };
    const f = fixture({
      [CEILING]: ceiling,
      [`src/reader.${ext}`]: readers[ext] ?? "",
      "CHANGELOG.md": "old",
    });
    f.write("CHANGELOG.md", "SQL: INSERT");
    expect(f.run().findings.some((x) => x.kind === "changelog-production-reader")).toBe(true);
  });
  it("collects unchanged readers with encoded path literals", () => {
    const f = fixture({
      [CEILING]: ceiling,
      "src/reader.tsx": "readFileSync('\\x43HANGELOG.md')",
      "CHANGELOG.md": "old",
    });
    f.write("CHANGELOG.md", "SQL: INSERT");
    expect(f.run().findings.some((x) => x.kind === "changelog-production-reader")).toBe(true);
  });
  it.each([
    "const label = '.deft/approved-scope/story.json';",
    "import React from 'react'; const label = '.deft/approved-scope/';",
    "// readFileSync('.deft/approved-scope/story.json')",
    "const example = `readFileSync('.deft/approved-scope/story.json')`;",
    "const label = '.deft/approved-scope/story.json'; console.log(label);",
    "export function View() { return <code>{'.deft/approved-scope/story.json'}</code>; }",
  ])("keeps JSON labels and examples exempt: %s", (source) => {
    const f = fixture({ [CEILING]: ceiling, [RECORD]: "{}", "src/app.tsx": source });
    f.write(RECORD, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(0);
  });
  it.each([
    "const path = '.deft/approved-scope/story.json'; readFileSync(path);",
    "import record from './.deft/approved-scope/story.json';",
    "const path = '.deft/approved-scope/story.json'; fetch(path);",
  ])("revokes JSON exemptions for executable path inputs: %s", (source) => {
    const f = fixture({ [CEILING]: ceiling, [RECORD]: "{}", "src/app.tsx": source });
    f.write(RECORD, '{"seedSql":"INSERT"}');
    expect(f.run().findings.some((x) => x.kind === "json-exemption-referenced")).toBe(true);
  });
  it.each([RECORD, "CHANGELOG.md"])("follows later assignments to %s", (path) => {
    const f = fixture({
      [CEILING]: ceiling,
      [path]: "{}",
      "src/app.tsx": `let path; path = '${path}'; const alias = path; readFileSync(alias); path = 'unrelated';`,
    });
    f.write(path, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(1);
  });
  it.each([RECORD, "CHANGELOG.md"])("retains earlier protected values for %s", (path) => {
    const f = fixture({
      [CEILING]: ceiling,
      [path]: "{}",
      "src/app.tsx": `let path = '${path}'; readFileSync(path); path = 'unrelated';`,
    });
    f.write(path, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(1);
  });
  it.each([
    RECORD,
    "CHANGELOG.md",
  ])("follows protected reassignment after an unrelated initializer: %s", (path) => {
    const f = fixture({
      [CEILING]: ceiling,
      [path]: "{}",
      "src/app.tsx": `let path = 'unrelated'; path = '${path}'; readFileSync(path);`,
    });
    f.write(path, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(1);
  });
  it.each([
    RECORD,
    "CHANGELOG.md",
  ])("keeps later assignments used only as printed labels exempt: %s", (path) => {
    const f = fixture({
      [CEILING]: ceiling,
      [path]: "{}",
      "src/app.tsx": `let label; label = '${path}'; console.log(label);`,
    });
    f.write(path, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(0);
  });
  it.each([
    ["path = 'CHANGELOG.md'\ndata = open(path).read()", 1],
    ['path = r"CHANGELOG.md"\ndata = open(path).read()', 1],
    ["path = 'CHANGELOG.md'\nalias = path\nwith open(alias) as file:\n    data = file.read()", 1],
    ["path = 'CHANGELOG.md'\nprint(path)", 0],
    ["path = 'CHANGELOG.md'\n# open(path)\nprint(path)", 0],
    ["help_text = \"open('CHANGELOG.md')\"\nprint(help_text)", 0],
    ['"""Example: open(\'CHANGELOG.md\')"""\nprint("hello")', 0],
    ['path = "CHANGELOG.md"\nexample = "open(path)"', 0],
    ["def format_label(label='CHANGELOG.md'):\n    return label", 0],
    ["async def format_label(label='CHANGELOG.md'):\n    return label", 0],
    ["def format_label(label=open('CHANGELOG.md').read()):\n    return label", 1],
    ["def read_label(label='CHANGELOG.md'):\n    return open(label).read()", 1],
    ["label = 'CHANGELOG.md'\nformat_label(label)", 1],
    ["class Label(object):\n    label = 'CHANGELOG.md'", 0],
    ["class Label(make_base('CHANGELOG.md')):\n    pass", 1],
    ["class Label(object):\n    label = open('CHANGELOG.md').read()", 1],
  ] as const)("recognizes executable fallback readers only: %s", (source, expected) => {
    const f = fixture({ [CEILING]: ceiling, "CHANGELOG.md": "old", "src/app.py": source });
    f.write("CHANGELOG.md", "SQL: INSERT");
    expect(f.run().exitCode).toBe(expected);
  });
  it.each([
    ["path = '.deft/approved-scope/story.json'\ndata = open(path).read()", 1],
    ["path = '.deft/approved-scope/story.json'\nprint(path)", 0],
    ["label = '.deft/approved-scope/story.json'\ncount = 1 + 2\nprint(label)", 0],
    [
      "label = '.deft/approved-scope/story.json'\npath = join('assets', 'icon.svg')\nprint(label)",
      0,
    ],
    ["root = '.deft/approved-scope/'\npath = root + identifier + '.json'", 1],
    ["root = '.deft/approved-scope/'\npath = join(root, identifier)", 1],
    ["help_text = \"open('.deft/approved-scope/story.json')\"", 0],
  ] as const)("applies the same fallback input contract to JSON: %s", (source, expected) => {
    const f = fixture({ [CEILING]: ceiling, [RECORD]: "{}", "src/app.py": source });
    f.write(RECORD, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(expected);
  });
  it("retains baseline reader bytes even when head removes the access", () => {
    const f = fixture({
      [CEILING]: ceiling,
      "src/reader.tsx": "readFileSync('CHANGELOG.md')",
      "CHANGELOG.md": "old",
    });
    f.write("src/reader.tsx", "export const label = 'CHANGELOG.md';");
    f.write("CHANGELOG.md", "SQL: INSERT");
    expect(f.run().findings.some((x) => x.kind === "changelog-production-reader")).toBe(true);
  });
  it("does not mistake an unrelated loadRecord for the approved-scope loader", () => {
    const f = fixture({
      [CEILING]: ceiling,
      [RECORD]: "{}",
      "src/app.ts": "import { loadRecord } from './decision.js'; const x = loadRecord(id);",
    });
    f.write(RECORD, '{"seedSql":"INSERT"}');
    expect(f.run().exitCode).toBe(0);
  });
  it.each([
    "import { readApprovedScopeRecord as read } from '../packages/core/src/scope-provenance/digest.js'; use(read(root,id).seedSql);",
    "import * as records from '../packages/core/src/scope-provenance/digest.js'; use(records.listApprovedScopeRecords(root));",
    "const { loadRecord: read } = require('../packages/core/src/scope-provenance/digest.js'); use(read(root,id));",
    "import { scopeProvenance as records } from '@deftai/directive-core'; use(records.readApprovedScopeRecord(root,id).seedSql);",
    "const { scopeProvenance: records } = require('@deftai/directive-core'); use(records.readApprovedScopeRecord(root,id).seedSql);",
  ])("connects approved-scope loader imports to their use: %s", (reader) => {
    const f = fixture({ [CEILING]: ceiling, [RECORD]: "{}", "src/app.tsx": reader });
    f.write(RECORD, '{"seedSql":"INSERT"}');
    expect(f.run().findings.some((x) => x.kind === "json-exemption-referenced")).toBe(true);
  });
  it("retains baseline xbrief references when head changes the reader", () => {
    const brief = "xbrief/active/a.xbrief.json";
    const f = fixture({
      [brief]: JSON.stringify({ plan: { "x-directive/changeClass": "presentation" } }),
      "src/app.tsx": `readFileSync('${brief}')`,
    });
    f.write("src/app.tsx", "export const label = 'removed';");
    f.write(
      brief,
      JSON.stringify({ plan: { "x-directive/changeClass": "presentation", seedSql: "INSERT" } }),
    );
    expect(f.run().findings.some((x) => x.kind === "json-exemption-referenced")).toBe(true);
  });
  it("fails closed on malformed baseline ceiling JSON", () => {
    const f = fixture({ [CEILING]: '{"changeClass":"presentation"' });
    f.write("View.tsx", "export const View = () => <div/>;");
    expect(f.run().exitCode).toBe(2);
  });
  it("fails closed on malformed baseline policy", () => {
    const f = fixture({ [CEILING]: ceiling, ".deft/test-boundary.policy.json": "{" });
    f.write("View.tsx", "export const View = () => <div/>;");
    expect(f.run().exitCode).toBe(2);
  });
  it("passes a clean armed worktree", () => {
    const f = fixture({ [CEILING]: ceiling });
    expect(f.run().exitCode).toBe(0);
  });
  it.each([
    [[".html"], "View.jsx", 1],
    [[], "page.html", 1],
    [[".html"], "page.html", 0],
    [[".html"], "save.sql", 1],
  ] as const)("composes head-only narrowing without granting extras: %s %s", (allowedExtensions, path, expected) => {
    const f = fixture({ "README.md": "project" });
    f.write(
      CEILING,
      JSON.stringify({
        changeClass: "presentation",
        allowedExtensions,
        extensionAmendment: {
          extensions: [".jsx", ".sql"],
          humanApproval: { kind: "operator", actor: "human", mintedAt: "2026-09-28T00:00:00Z" },
        },
      }),
    );
    f.write(path, "presentation");
    expect(f.run().exitCode).toBe(expected);
  });
});

it("treats an explicit empty allowlist as a restriction, not omission", () => {
  const f = fixture({
    [CEILING]: JSON.stringify({ changeClass: "presentation", allowedExtensions: [] }),
  });
  f.write("View.tsx", "export const View = () => <div/>;");
  expect(f.run().exitCode).toBe(1);
});
