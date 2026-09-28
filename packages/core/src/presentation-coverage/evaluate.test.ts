import { afterEach, describe, expect, it } from "vitest";
import { buildIntentConstraintRecord } from "../intent-constraint/mint.js";
import { buildObservableScopeRecord } from "../observable-scope/mint.js";
import { evaluatePresentationCoverage } from "./evaluate.js";
import { COMPOSED_GATE_IDS, runComposedGates } from "./gates.js";
import type { CoverageSnapshot, SnapshotTree } from "./snapshot.js";
import type { ComposedGateCoverage } from "./types.js";

const REL = ".deft/presentation-ceiling.json";
const STORY = "xbrief/active/story.xbrief.json";
const stamp = { kind: "operator", actor: "David", mintedAt: "2026-09-28T00:00:00Z" };
const ceiling = JSON.stringify({ changeClass: "presentation" });
const observable = { changeKind: "fields-only", allowedChanges: [] };
const intent = { constraints: [{ value: "10", unit: "records", rejectionScope: "item" }] };
const story = JSON.stringify({
  plan: {
    id: "current",
    status: "running",
    metadata: { swarm: { file_scope: ["public/**", "src/**", "db/**", "styles/**"] } },
    "x-directive/observableChange": observable,
    "x-directive/intentConstraint": intent,
  },
});
function tree(files: Record<string, string>): SnapshotTree {
  return { paths: Object.keys(files), errors: [], read: (p) => files[p] ?? null };
}
function snapshot(
  changed: string[],
  base: Record<string, string> = {},
  head: Record<string, string> = base,
): CoverageSnapshot {
  return {
    projectRoot: "/tmp/deft-coverage-fixture",
    mergeBase: "base",
    candidate: "head",
    changed,
    base: tree(base),
    head: tree(head),
  };
}
function complete(s: CoverageSnapshot): ComposedGateCoverage[] {
  return COMPOSED_GATE_IDS.map((gateId) => ({
    gateId,
    status: "evaluated",
    code: 0,
    analyzedPaths: s.changed,
    cannotEvaluatePaths: [],
    message: "executed test adapter",
  }));
}
const evaluate = (s: CoverageSnapshot, runner = complete) =>
  evaluatePresentationCoverage({ snapshot: s, gateRunner: runner, planId: "current" });
afterEach(() => delete process.env.DEFT_ACTIVE_SCOPE);
describe("presentation coverage composition", () => {
  it.each([
    "public/index.html",
    "src/View.tsx",
    "db/001.sql",
    "src/save.ts",
    "styles/app.css",
  ])("head restriction never admits %s", (path) => {
    const r = evaluate(snapshot([REL, path], {}, { [REL]: ceiling, [path]: "content" }));
    expect(r.code).toBe(1);
    expect(r.armed).toBe(true);
    expect(r.uncoveredPaths).toContain(path);
  });
  it("mixed supported and unsupported paths remain separate", () => {
    const r = evaluate(snapshot(["src/save.ts", "db/001.sql"], { [REL]: ceiling, [STORY]: story }));
    expect(r.code).toBe(1);
    expect(r.uncoveredPaths).toEqual(["src/save.ts", "db/001.sql"]);
  });
  it.each([
    1, 2,
  ] as const)("preserves actual required gate code %s before any admission", (code) => {
    const s = snapshot(["public/index.html"], { [REL]: ceiling, [STORY]: story });
    const r = evaluate(s, (s) =>
      complete(s).map((c) => (c.gateId === "verify:intent-constraint" ? { ...c, code } : c)),
    );
    expect(r.code).toBe(code);
    expect(r.message).toContain("verify:intent-constraint");
  });
  it("marks unrun required gates unknown, never successful", () => {
    const r = evaluate(snapshot([REL], {}, { [REL]: ceiling }), () => []);
    expect(r.code).toBe(2);
    expect(r.coverage.every((c) => c.status === "unrun" && c.code === null)).toBe(true);
  });
  it("off-ceiling never runs composition or changes narrow gate behavior", () => {
    let ran = false;
    const r = evaluate(snapshot(["src/save.ts"]), () => {
      ran = true;
      return [];
    });
    expect(r.code).toBe(0);
    expect(r.skipped).toBe(true);
    expect(ran).toBe(false);
  });
  it("listed-but-unreadable authority is not absent", () => {
    const s = snapshot([], {});
    const errors: string[] = [];
    const r = evaluate({
      ...s,
      base: {
        paths: [REL],
        errors,
        read: () => {
          errors.push("listed blob unreadable");
          return null;
        },
      },
    });
    expect(r.code).toBe(2);
    expect(r.message).toContain("unreadable");
    expect(r.message).toContain("Repair the reported snapshot");
    expect(r.message).not.toContain("obtain merge-base human authority");
  });
  it("base restriction cannot be weakened by a signed head amendment", () => {
    const s = snapshot(
      [REL, "public/index.html"],
      { [REL]: ceiling },
      {
        [REL]: JSON.stringify({
          changeClass: "presentation",
          extensionAmendment: { extensions: [".sql"], humanApproval: stamp },
        }),
      },
    );
    expect(evaluate(s)).toMatchObject({ code: 1, compare: { kind: "weakening" } });
  });
  it("a valid base amendment admits only the base story scope and simultaneous restrictions", () => {
    const art = JSON.stringify({
      changeClass: "presentation",
      componentRoots: ["db/**"],
      extensionAmendment: { extensions: [".sql"], humanApproval: stamp },
    });
    const s = snapshot(["db/001.sql"], { [REL]: art, [STORY]: story });
    const r = evaluate(s);
    expect(r.code).toBe(0);
    expect(r.admissions).toEqual([
      {
        path: "db/001.sql",
        ruleId: "presentation-extension-amendment",
        authority: `base:${REL}#extensionAmendment`,
        planId: "current",
      },
    ]);
    expect(evaluate({ ...s, changed: ["other/001.sql"] }).code).toBe(1);
    const next = tree({
      [REL]: JSON.stringify({
        changeClass: "presentation",
        componentRoots: ["db/narrow/**"],
        extensionAmendment: { extensions: [".sql"], humanApproval: stamp },
      }),
      [STORY]: story,
    });
    expect(evaluate({ ...s, head: next })).toMatchObject({
      code: 1,
      compare: { kind: "tightening" },
    });
    expect(evaluate({ ...s, head: next, changed: ["db/narrow/001.sql"] })).toMatchObject({
      code: 0,
      compare: { kind: "tightening" },
    });
  });
  it("recomputes a matching observable mint with a real parser; stale/unrelated mints fail", () => {
    const mint = buildObservableScopeRecord({
      planId: "current",
      xbriefRelPath: STORY,
      allowedChanges: [],
      humanApproval: stamp,
    });
    const files = {
      [REL]: ceiling,
      [STORY]: story,
      ".deft/observable-ui.policy.json": JSON.stringify({
        schema: "deft.observable-ui.policy.v1",
        surfaces: ["public/**"],
      }),
      ".deft/observable-scope/current.json": JSON.stringify(mint),
      "public/index.html": "<h1>Hello</h1>",
    };
    const s = snapshot(["public/index.html"], files, {
      ...files,
      "public/index.html": "<h1 class='new'>Hello</h1>",
    });
    expect(evaluate(s)).toMatchObject({
      code: 0,
      admissions: [
        {
          path: "public/index.html",
          ruleId: "observable-scope-mint",
          authority: "base:.deft/observable-scope/current.json",
        },
      ],
    });
    const stale = {
      ...files,
      ".deft/observable-scope/current.json": JSON.stringify({ ...mint, planId: "previous" }),
    };
    expect(evaluate(snapshot(["public/index.html"], stale)).code).toBe(1);
    expect(
      evaluate({
        ...s,
        head: tree({
          ...files,
          [STORY]: story.replace(
            '"allowedChanges":[]',
            '"allowedChanges":[{"kind":"heading","op":"add"}]',
          ),
        }),
      }).code,
    ).toBe(1);
    expect(
      evaluate(s, (x) =>
        complete(x).map((c) =>
          c.gateId === "verify:observable-scope" ? { ...c, cannotEvaluatePaths: x.changed } : c,
        ),
      ).code,
    ).toBe(1);
  });
  it("base intent mint cannot authorize a path outside base file_scope or a failing real intent evaluator", () => {
    const mint = buildIntentConstraintRecord({
      planId: "current",
      xbriefRelPath: STORY,
      constraints: [{ value: "10", unit: "records", rejectionScope: "item" }],
      humanApproval: stamp,
    });
    const art = JSON.stringify({
      changeClass: "presentation",
      extensionAmendment: { extensions: [".ts"], humanApproval: stamp },
    });
    const files = {
      [REL]: art,
      [STORY]: story,
      ".deft/intent-constraint/current.json": JSON.stringify(mint),
      "src/save.ts": "export const ok = true;",
    };
    const s = snapshot(["src/save.ts"], files, {
      ...files,
      "src/save.ts": "export const cap = 500;",
    });
    const r = evaluate(s, (x) => {
      const executed = runComposedGates(x, "current");
      return complete(x).map((c) =>
        c.gateId === "verify:intent-constraint" ? executed.find((e) => e.gateId === c.gateId)! : c,
      );
    });
    expect(r.code).not.toBe(0);
    expect(r.coverage.find((c) => c.gateId === "verify:intent-constraint")?.code).not.toBe(0);
  });
});

it("accepts a restriction-only base-stamped removal after all evaluators run", () => {
  const s = snapshot(
    [REL],
    { [REL]: JSON.stringify({ changeClass: "presentation", removalStamp: stamp }) },
    {},
  );
  expect(evaluate(s)).toMatchObject({ code: 0, compare: { kind: "removal" }, admissions: [] });
});
it("never interprets malformed authority or adapter-time read failure as absence", () => {
  expect(evaluate(snapshot([], { [REL]: "{" })).code).toBe(2);
  expect(evaluate(snapshot([], {}, { [REL]: "{" })).code).toBe(2);
  const s = snapshot([REL], {}, { [REL]: ceiling });
  expect(
    evaluate(s, (x) => {
      x.head.errors.push("policy blob unreadable");
      return complete(x);
    }).code,
  ).toBe(2);
});

it.each([
  "public/index.html",
  "styles/app.css",
])("a base amendment cannot restore excluded builtin %s", (path) => {
  const art = JSON.stringify({
    changeClass: "presentation",
    allowedExtensions: [],
    extensionAmendment: { extensions: [".html", ".css"], humanApproval: stamp },
  });
  expect(evaluate(snapshot([path], { [REL]: art, [STORY]: story }))).toMatchObject({
    code: 1,
    uncoveredPaths: [path],
  });
});
it("an amendment naming a builtin cannot provide its missing mint", () => {
  const art = JSON.stringify({
    changeClass: "presentation",
    extensionAmendment: { extensions: [".css"], humanApproval: stamp },
  });
  expect(evaluate(snapshot(["styles/app.css"], { [REL]: art, [STORY]: story })).code).toBe(1);
});

it.each([
  false,
  true,
])("a stamped removal cannot mask another record's weakening (reverse=%s)", (reverse) => {
  const second = ".deft/other/presentation-ceiling.json";
  const stamped = JSON.stringify({ changeClass: "presentation", removalStamp: stamp });
  const narrow = JSON.stringify({ changeClass: "presentation", allowedExtensions: [".html"] });
  const records = reverse
    ? { [second]: narrow, [REL]: stamped }
    : { [REL]: stamped, [second]: narrow };
  const r = evaluate(snapshot([REL, second], records, { [second]: ceiling }));
  expect(r).toMatchObject({ code: 1, compare: { kind: "weakening" } });
});

it("distinguishes malformed active-story configuration from missing authority", () => {
  const malformed = snapshot(["public/index.html"], { [REL]: ceiling, [STORY]: "{" });
  expect(evaluate(malformed).code).toBe(2);
  const missing = snapshot(["public/index.html"], { [REL]: ceiling });
  expect(evaluate(missing).code).toBe(1);
});
