import { describe, expect, it } from "vitest";
import { REQUIRED_CONSUMER_ENFORCEMENT_GATES } from "../consumer-check-contract/evaluate.js";
import { evaluatePresentationCeiling } from "./evaluate.js";
import { PRESENTATION_CEILING_SCHEMA } from "./types.js";

const REL = ".deft/presentation-ceilings/story.json";

function restriction(): string {
  return `${JSON.stringify({
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: "presentation",
  })}\n`;
}

function intentNa(): {
  code: 0;
  message: string;
  stream: "stdout";
  skipped: true;
  analyzedPaths: readonly string[];
} {
  return {
    code: 0,
    message: "verify:intent-constraint: N/A — no changed production .ts/.js files.",
    stream: "stdout",
    skipped: true,
    analyzedPaths: [],
  };
}

function intentNoFacts(path: string): {
  code: 0;
  message: string;
  stream: "stdout";
  skipped: false;
  analyzedPaths: readonly string[];
} {
  return {
    code: 0,
    message: "verify:intent-constraint: no new throw/reject/abort sites or numeric consts",
    stream: "stdout",
    skipped: false,
    analyzedPaths: [path],
  };
}

function observableWarn(path: string): {
  code: 0;
  message: string;
  stream: "stdout";
  skipped: false;
  findings: readonly { kind: "non-adoption"; path: string; detail: string }[];
  analyzedPaths: readonly string[];
} {
  return {
    code: 0,
    message: "verify:observable-scope: WARN 1 non-adoption finding(s)",
    stream: "stdout",
    skipped: false,
    findings: [{ kind: "non-adoption", path, detail: "unset policy" }],
    analyzedPaths: [path],
  };
}

function observableNa(): {
  code: 0;
  message: string;
  stream: "stdout";
  skipped: true;
  analyzedPaths: readonly string[];
} {
  return {
    code: 0,
    message: "verify:observable-scope: N/A — no base-pinned observable-ui surfaces policy",
    stream: "stdout",
    skipped: true,
    analyzedPaths: [],
  };
}

function firstPr(changed: readonly string[]) {
  return evaluatePresentationCeiling({
    projectRoot: "/tmp/ceiling-proj",
    mergeBase: "base",
    changedFiles: [REL, ...changed],
    baseArtifacts: new Map(),
    headArtifacts: new Map([[REL, restriction()]]),
    intentResult: changed.some((p) => p.endsWith(".ts") || p.endsWith(".js"))
      ? intentNoFacts(changed.find((p) => p.endsWith(".ts") || p.endsWith(".js")) ?? "src/save.ts")
      : intentNa(),
    observableResult: changed.some((p) => p.endsWith(".html") || p.endsWith(".tsx"))
      ? observableWarn(
          changed.find((p) => p.endsWith(".html") || p.endsWith(".tsx")) ?? "src/View.tsx",
        )
      : observableNa(),
    intentRecordsAtBase: new Map(),
    observableRecordsAtBase: new Map(),
  });
}

describe("evaluatePresentationCeiling (#5079)", () => {
  it("keeps the composed-gate list as REQUIRED_CONSUMER_ENFORCEMENT_GATES", () => {
    expect(REQUIRED_CONSUMER_ENFORCEMENT_GATES).toContain("verify:intent-constraint");
    expect(REQUIRED_CONSUMER_ENFORCEMENT_GATES).toContain("verify:observable-scope");
    expect(REQUIRED_CONSUMER_ENFORCEMENT_GATES).not.toContain("verify:presentation-ceiling");
  });

  it("refuses first PR head restriction plus public/index.html", () => {
    const r = firstPr(["public/index.html"]);
    expect(r.code).toBe(1);
    expect(r.armed).toBe(true);
    expect(r.uncoveredPaths).toContain("public/index.html");
    expect(r.uncoveredPaths).not.toContain(REL);
    expect(r.message).toMatch(/refuse|cannot evaluate/i);
    expect(r.message).toMatch(/skipped required gates are not a green pass/);
  });

  it("refuses first PR plus src/View.tsx", () => {
    const r = firstPr(["src/View.tsx"]);
    expect(r.code).toBe(1);
    expect(r.uncoveredPaths).toContain("src/View.tsx");
  });

  it("refuses first PR plus db/001.sql independent of purity", () => {
    const r = firstPr(["db/001.sql"]);
    expect(r.code).toBe(1);
    expect(r.uncoveredPaths).toContain("db/001.sql");
  });

  it("refuses first PR plus src/save.ts with no new FACT_KINDS", () => {
    const r = firstPr(["src/save.ts"]);
    expect(r.code).toBe(1);
    expect(r.uncoveredPaths).toContain("src/save.ts");
  });

  it("refuses same-PR weaken of a merge-base ceiling on src/View.tsx", () => {
    const r = evaluatePresentationCeiling({
      projectRoot: "/tmp/ceiling-proj",
      mergeBase: "base",
      changedFiles: [REL, "src/View.tsx"],
      baseArtifacts: new Map([[REL, restriction()]]),
      headArtifacts: new Map([
        [
          REL,
          `${JSON.stringify({
            schema: PRESENTATION_CEILING_SCHEMA,
            changeClass: "presentation",
            extraExtensions: [".sql"],
            humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-09-28T00:00:00Z" },
          })}\n`,
        ],
      ]),
      intentResult: intentNa(),
      observableResult: observableWarn("src/View.tsx"),
      intentRecordsAtBase: new Map(),
      observableRecordsAtBase: new Map(),
    });
    expect(r.code).toBe(1);
    expect(r.compare.kind).toBe("weakening");
    expect(r.message).toMatch(/weaken|removal/i);
  });

  it("does not admit mixed .ts + .sql on a no-new-facts .ts pass", () => {
    const r = evaluatePresentationCeiling({
      projectRoot: "/tmp/ceiling-proj",
      mergeBase: "base",
      changedFiles: [REL, "src/save.ts", "db/001.sql"],
      baseArtifacts: new Map(),
      headArtifacts: new Map([[REL, restriction()]]),
      intentResult: intentNoFacts("src/save.ts"),
      observableResult: observableNa(),
      intentRecordsAtBase: new Map(),
      observableRecordsAtBase: new Map(),
    });
    expect(r.code).toBe(1);
    expect(r.uncoveredPaths).toContain("db/001.sql");
  });

  it("refuses markup .tsx with unset observable policy (not warn-exit-0)", () => {
    const r = firstPr(["src/View.tsx"]);
    expect(r.code).toBe(1);
    expect(
      r.coverage.some(
        (c) =>
          c.gateId === "verify:observable-scope" && c.cannotEvaluatePaths.includes("src/View.tsx"),
      ),
    ).toBe(true);
  });

  it("refuses continue without a recomputed merge-base admission rule", () => {
    const r = firstPr(["src/View.tsx"]);
    expect(r.code).toBe(1);
    expect(r.message).not.toMatch(/continue — every changed path/);
  });

  it("refuses css-only under an armed ceiling", () => {
    const r = firstPr(["styles/app.css"]);
    expect(r.code).toBe(1);
    expect(r.uncoveredPaths).toContain("styles/app.css");
  });

  it("leaves off-ceiling presentation-only N/A at 0", () => {
    const r = evaluatePresentationCeiling({
      projectRoot: "/tmp/ceiling-proj",
      mergeBase: "base",
      changedFiles: ["public/index.html"],
      baseArtifacts: new Map(),
      headArtifacts: new Map(),
      intentResult: intentNa(),
      observableResult: observableWarn("public/index.html"),
      intentRecordsAtBase: new Map(),
      observableRecordsAtBase: new Map(),
    });
    expect(r.code).toBe(0);
    expect(r.armed).toBe(false);
    expect(r.skipped).toBe(true);
  });

  it("does not recut #4541 off-ceiling production .ts skip/filter", () => {
    const r = evaluatePresentationCeiling({
      projectRoot: "/tmp/ceiling-proj",
      mergeBase: "base",
      changedFiles: ["src/save.ts"],
      baseArtifacts: new Map(),
      headArtifacts: new Map(),
      intentResult: intentNoFacts("src/save.ts"),
      observableResult: observableNa(),
      intentRecordsAtBase: new Map(),
      observableRecordsAtBase: new Map(),
    });
    expect(r.code).toBe(0);
    expect(r.armed).toBe(false);
  });

  it("emits structured per-path coverage from composed gates", () => {
    const r = firstPr(["public/index.html"]);
    const intent = r.coverage.find((c) => c.gateId === "verify:intent-constraint");
    const observable = r.coverage.find((c) => c.gateId === "verify:observable-scope");
    expect(intent?.skipped).toBe(true);
    expect(observable?.cannotEvaluatePaths).toContain("public/index.html");
  });

  it("fails closed on a malformed ceiling artifact", () => {
    const r = evaluatePresentationCeiling({
      projectRoot: "/tmp/ceiling-proj",
      mergeBase: "base",
      changedFiles: [REL],
      baseArtifacts: new Map(),
      headArtifacts: new Map([[REL, "{not json"]]),
      intentResult: intentNa(),
      observableResult: observableNa(),
      intentRecordsAtBase: new Map(),
      observableRecordsAtBase: new Map(),
    });
    expect(r.code).toBe(2);
  });

  it("continues when a merge-base extraExtensions amendment covers the path", () => {
    const base = `${JSON.stringify({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "presentation",
      extraExtensions: [".sql"],
    })}\n`;
    const r = evaluatePresentationCeiling({
      projectRoot: "/tmp/ceiling-proj",
      mergeBase: "base",
      changedFiles: ["db/001.sql"],
      baseArtifacts: new Map([[REL, base]]),
      headArtifacts: new Map([[REL, base]]),
      intentResult: intentNa(),
      observableResult: observableNa(),
      intentRecordsAtBase: new Map(),
      observableRecordsAtBase: new Map(),
    });
    expect(r.code).toBe(0);
    expect(r.armed).toBe(true);
    expect(r.message).toMatch(/continue/);
  });
});
