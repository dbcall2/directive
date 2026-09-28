import { describe, expect, it } from "vitest";
import { evaluateClassChecks } from "../class-checks/evaluate.js";
import { defaultClassChecksPolicy } from "../class-checks/policy.js";
import { defaultTestBoundaryPolicy } from "../test-boundary/policy.js";
import {
  evaluatePresentationCeilingFromSnapshot,
  isApprovedScopeRecordPath,
  isBuiltinPresentationPath,
  parseCeilingPayload,
} from "./evaluate.js";
import {
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
  type PresentationCeilingArtifact,
  type PresentationCeilingSnapshot,
  type PresentationHumanApproval,
} from "./types.js";

const HUMAN: PresentationHumanApproval = {
  kind: "operator",
  actor: "david",
  mintedAt: "2026-09-27T00:00:00Z",
};

function artifact(
  path: string,
  overrides: Partial<PresentationCeilingArtifact> = {},
): PresentationCeilingArtifact {
  return {
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: PRESENTATION_CHANGE_CLASS,
    path,
    allowedExtensions: [],
    componentRoots: [],
    extensionAmendment: null,
    removalStamp: null,
    ...overrides,
  };
}

function snap(
  overrides: Partial<PresentationCeilingSnapshot> & {
    readonly changedFiles: readonly string[];
  },
): PresentationCeilingSnapshot {
  return {
    baseArtifacts: [],
    headArtifacts: [],
    baseActiveXbriefPath: null,
    headFileContents: new Map(),
    standingFileContents: new Map(),
    baseTestRoots: [],
    baseFixtureRoots: [],
    defaultTestRoots: ["tests/**", "**/__tests__/**"],
    defaultFixtureRoots: ["**/fixtures/**"],
    ...overrides,
  };
}

const CEILING = PRESENTATION_CEILING_ARTIFACT_REL;
const ACTIVE_A = "xbrief/active/a.xbrief.json";
const ACTIVE_B = "xbrief/active/b.xbrief.json";

describe("presentation-ceiling helpers (#5056)", () => {
  it("treats html/jsx/tsx/css as built-in presentation paths", () => {
    expect(isBuiltinPresentationPath("src/View.tsx")).toBe(true);
    expect(isBuiltinPresentationPath("src/App.jsx")).toBe(true);
    expect(isBuiltinPresentationPath("page.html")).toBe(true);
    expect(isBuiltinPresentationPath("src/styles.css")).toBe(true);
    expect(isBuiltinPresentationPath("src/save.js")).toBe(false);
    expect(isBuiltinPresentationPath("db/001.sql")).toBe(false);
    expect(isBuiltinPresentationPath("Program.cs")).toBe(false);
  });

  it("limits JSON exemption candidates to approved-scope records and preimages", () => {
    expect(isApprovedScopeRecordPath(".deft/approved-scope/story.json")).toBe(true);
    expect(isApprovedScopeRecordPath(".deft/approved-scope/story.intent.json")).toBe(true);
    expect(isApprovedScopeRecordPath(".deft/approved-scope/save.js")).toBe(false);
    expect(isApprovedScopeRecordPath("src/save.js")).toBe(false);
  });

  it("parses changeClass presentation from a standalone artifact and an xBRIEF key", () => {
    expect(
      parseCeilingPayload(
        { schema: PRESENTATION_CEILING_SCHEMA, changeClass: "presentation" },
        CEILING,
      )?.changeClass,
    ).toBe("presentation");
    expect(
      parseCeilingPayload(
        { plan: { "x-directive/changeClass": { changeClass: "presentation" } } },
        ACTIVE_A,
      )?.path,
    ).toBe(ACTIVE_A);
    expect(parseCeilingPayload({ changeClass: "backend" }, CEILING)).toBeNull();
  });
});

describe("evaluatePresentationCeilingFromSnapshot (#5056 tests lock)", () => {
  it("skips when no ceiling is recorded", () => {
    const result = evaluatePresentationCeilingFromSnapshot(snap({ changedFiles: ["db/001.sql"] }));
    expect(result.exitCode).toBe(0);
    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/skipped/);
    expect(result.unevaluatedNote).toMatch(/cannot be cited/);
  });

  it("refuses single-PR lifecycle move of ceiling-bound A plus head-only B plus db/001.sql", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [ACTIVE_A, ACTIVE_B, "db/001.sql"],
        baseArtifacts: [artifact(ACTIVE_A)],
        headArtifacts: [artifact(ACTIVE_B)],
        baseActiveXbriefPath: ACTIVE_A,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "ceiling-removal")).toBe(true);
    expect(result.findings.some((f) => f.path === "db/001.sql")).toBe(true);
  });

  it("refuses two-PR mint of B then db/001.sql while A's base ceiling remains", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [ACTIVE_B, "db/001.sql"],
        baseArtifacts: [artifact(ACTIVE_A)],
        headArtifacts: [artifact(ACTIVE_A), artifact(ACTIVE_B)],
        baseActiveXbriefPath: ACTIVE_A,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "db/001.sql")).toBe(true);
  });

  it("refuses already-present broad base root plus unchanged ceiling plus zero-fact save.js", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["src/components/save.js"],
        baseArtifacts: [
          artifact(CEILING, { componentRoots: ["src/components/**"], allowedExtensions: [".js"] }),
        ],
        headArtifacts: [
          artifact(CEILING, { componentRoots: ["src/components/**"], allowedExtensions: [".js"] }),
        ],
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "src/components/save.js")).toBe(true);
  });

  it("admits Views/Home/Index.cshtml when the merge-base artifact stamps .cshtml", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["Views/Home/Index.cshtml"],
        baseArtifacts: [
          artifact(CEILING, {
            extensionAmendment: { extensions: [".cshtml"], humanApproval: HUMAN },
          }),
        ],
        headArtifacts: [artifact(CEILING)],
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.armed).toBe(true);
  });

  it("ignores the same .cshtml amendment on head only", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["Views/Home/Index.cshtml", CEILING],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [
          artifact(CEILING, {
            extensionAmendment: { extensions: [".cshtml"], humanApproval: HUMAN },
          }),
        ],
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "Views/Home/Index.cshtml")).toBe(true);
  });

  it("refuses SELECT→INSERT in src/fixtures/save.js under default **/fixtures/**", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["src/fixtures/save.js"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        headFileContents: new Map([
          ["src/fixtures/save.js", "export function save() { return 'INSERT'; }\n"],
        ]),
        standingFileContents: new Map([
          ["src/importer.js", "import { save } from './fixtures/save.js';\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "src/fixtures/save.js")).toBe(true);
  });

  it("refuses db/fixtures/001.sql consumed by an unchanged loader", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["db/fixtures/001.sql"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([
          ["src/loader.js", "readFileSync('db/fixtures/001.sql');\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "db/fixtures/001.sql")).toBe(true);
  });

  it("admits SQL when the merge-base ceiling amendment names .sql", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["db/001.sql"],
        baseArtifacts: [
          artifact(CEILING, {
            extensionAmendment: { extensions: [".sql"], humanApproval: HUMAN },
          }),
        ],
        headArtifacts: [artifact(CEILING)],
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("ignores a head-only .sql amendment", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["db/001.sql", CEILING],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [
          artifact(CEILING, {
            extensionAmendment: { extensions: [".sql"], humanApproval: HUMAN },
          }),
        ],
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "db/001.sql")).toBe(true);
  });

  it("refuses .deft/approved-scope/save.js even with an unchanged importer", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [".deft/approved-scope/save.js"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([
          ["src/app.js", "import save from '../.deft/approved-scope/save.js';\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === ".deft/approved-scope/save.js")).toBe(true);
  });

  it("passes a first PR that adds a presentation ceiling plus src/View.tsx", () => {
    const changed = [CEILING, "src/View.tsx"];
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: changed,
        baseArtifacts: [],
        headArtifacts: [artifact(CEILING)],
        headFileContents: new Map([
          [CEILING, JSON.stringify({ changeClass: "presentation" })],
          ["src/View.tsx", "export function View() { return <div/>; }\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.armed).toBe(true);

    const classResult = evaluateClassChecks("/tmp/proj-5056-first-pr", {
      baseRef: "origin/master",
      changedFiles: changed,
      baseTestBoundaryPolicy: {
        ...defaultTestBoundaryPolicy("warn"),
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        allow: [],
      },
      classChecksPolicy: defaultClassChecksPolicy(),
      fileContents: new Map([
        [CEILING, "{}\n"],
        ["src/View.tsx", "export function View() { return null; }\n"],
      ]),
    });
    expect(classResult.exitCode).toBe(0);
    expect(defaultClassChecksPolicy().protectedGlobs).not.toContain(CEILING);
    expect(defaultClassChecksPolicy().protectedGlobs).not.toContain(
      ".deft/presentation-ceiling.json",
    );
    expect(defaultClassChecksPolicy().protectedGlobs).not.toContain(
      ".deft/presentation-ceiling/**",
    );
  });

  it("refuses same-PR weaken of a merge-base ceiling even with a head stamp", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [CEILING, "src/View.tsx"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [],
        headFileContents: new Map([
          [
            CEILING,
            JSON.stringify({
              humanApproval: HUMAN,
            }),
          ],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "ceiling-weaken")).toBe(true);
  });

  it("does not exempt an xBRIEF completed-path", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["xbrief/completed/old.xbrief.json"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "xbrief/completed/old.xbrief.json")).toBe(true);
  });

  it("continues a purely presentation diff inside the built-in set", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["src/View.tsx", "src/styles.css", "templates/page.html"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("refuses a changed seedSql key when an unchanged production reader calls loadRecord", () => {
    const rec = ".deft/approved-scope/story.json";
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [rec],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        baseActiveXbriefPath: ACTIVE_A,
        standingFileContents: new Map([
          ["src/index.js", "const rec = loadRecord(id);\nuse(rec.seedSql);\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "json-exemption-referenced")).toBe(true);
  });

  it("refuses a changed seedSql key when an unchanged reader calls readApprovedScopeRecord", () => {
    const rec = ".deft/approved-scope/story.json";
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [rec],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([
          ["src/boot.js", "const rec = readApprovedScopeRecord(root, id);\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "json-exemption-referenced")).toBe(true);
  });

  it("keeps the extra-key change exempt when only gate-tooling readers exist", () => {
    const rec = ".deft/approved-scope/story.json";
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [rec],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([
          [
            "packages/core/src/scope-provenance/digest.ts",
            "export function readApprovedScopeRecord() { return loadRecord(p); }\n",
          ],
        ]),
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("refuses a diff that adds src/index.js reading the ceiling artifact", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["src/index.js", CEILING],
        baseArtifacts: [],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([["src/index.js", `import cfg from './${CEILING}';\n`]]),
        headFileContents: new Map([["src/index.js", `import cfg from './${CEILING}';\n`]]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) => f.path === "src/index.js" || f.kind === "json-exemption-referenced",
      ),
    ).toBe(true);
  });

  it("refuses dynamic construction of an exempt JSON path in non-gate code", () => {
    const rec = ".deft/approved-scope/story.json";
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: [rec],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([
          ["src/dyn.js", "const p = '.deft/' + 'approved-scope/' + id + '.json';\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "dynamic-exempt-path")).toBe(true);
  });

  it("refuses unchanged src/index.js reading SQL: from CHANGELOG.md plus a changed INSERT line", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["CHANGELOG.md"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map([
          ["src/index.js", "const sql = readFileSync('CHANGELOG.md').split('SQL:')[1];\n"],
        ]),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "changelog-production-reader")).toBe(true);
  });

  it("passes an unreferenced CHANGELOG.md release-notes-only change", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["CHANGELOG.md"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
        standingFileContents: new Map(),
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("names extra ceremony on AGENTS.md without treating it as P1 out-of-class", () => {
    const result = evaluatePresentationCeilingFromSnapshot(
      snap({
        changedFiles: ["AGENTS.md"],
        baseArtifacts: [artifact(CEILING)],
        headArtifacts: [artifact(CEILING)],
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.kind).toBe("extra-ceremony");
  });
});
