import { expect, it } from "vitest";
import { parseCoverageReport } from "./report.js";

it("preserves typed evidence and rejects omitted required outcomes", () => {
  expect(parseCoverageReport(JSON.stringify({ code: 0, armed: false, coverage: [] }), 0)).toEqual({
    armed: false,
    coverage: [],
  });
  expect(parseCoverageReport("", 0)).toHaveProperty("error");
  expect(
    parseCoverageReport(
      JSON.stringify({ code: 0, armed: true, coverage: [], uncoveredPaths: [] }),
      0,
    ),
  ).toHaveProperty("error");
  expect(
    parseCoverageReport(JSON.stringify({ code: 1, armed: false, coverage: [] }), 0),
  ).toHaveProperty("error");
  expect(
    parseCoverageReport(JSON.stringify({ code: 0, armed: false, coverage: [{}] }), 0),
  ).toHaveProperty("error");
});

it("validates every typed row and keeps complete armed evidence", () => {
  const ids = [
    "verify:test-boundary",
    "verify:class-checks",
    "verify:scope-provenance",
    "verify:consumer-check-contract",
    "verify:evaluator-surface",
    "verify:observable-scope",
    "verify:intent-constraint",
  ];
  const row = {
    gateId: ids[0],
    status: "evaluated",
    code: 0,
    analyzedPaths: ["ui/a.html"],
    cannotEvaluatePaths: [],
    message: "checked",
  };
  const raw = {
    code: 0,
    armed: true,
    uncoveredPaths: [],
    coverage: ids.map((gateId) => ({ ...row, gateId })),
  };
  expect(parseCoverageReport(JSON.stringify(raw), 0)).toEqual({
    armed: true,
    coverage: raw.coverage,
  });
  for (const patch of [
    { gateId: null },
    { status: "unknown" },
    { code: 9 },
    { analyzedPaths: null },
    { analyzedPaths: [1] },
    { cannotEvaluatePaths: null },
    { cannotEvaluatePaths: [1] },
    { message: null },
  ]) {
    expect(
      parseCoverageReport(JSON.stringify({ ...raw, coverage: [{ ...row, ...patch }] }), 0),
    ).toHaveProperty("error");
  }
  for (const patch of [
    { uncoveredPaths: ["ui/a.html"] },
    { coverage: [...raw.coverage, row] },
    { coverage: [...raw.coverage, { ...row, code: 1 }] },
    { coverage: [...raw.coverage, { ...row, code: 2 }] },
    { coverage: [...raw.coverage, { ...row, code: null, status: "unrun" }] },
    { coverage: [...raw.coverage, { ...row, gateId: "unexpected-gate" }] },
    { coverage: raw.coverage.map((r) => ({ ...r, status: "unrun" })) },
  ]) {
    expect(parseCoverageReport(JSON.stringify({ ...raw, ...patch }), 0)).toHaveProperty("error");
  }
  expect(parseCoverageReport(JSON.stringify({ ...raw, code: 2 }), 2)).toEqual({
    armed: true,
    coverage: raw.coverage,
  });
});

it("accepts a terminal report after build diagnostics but rejects ambiguous streams", () => {
  const report = JSON.stringify({ code: 0, armed: false, coverage: [] });
  expect(
    parseCoverageReport(`> framework build\n[build] compiling\n$ tsc -b\n${report}\n`, 0),
  ).toEqual({ armed: false, coverage: [] });
  for (const text of [
    `${report}\n${report}`,
    `${report}\ntrailing diagnostics`,
    `{bad prefix}\n${report}`,
    `${JSON.stringify(JSON.parse(report), null, 2)}\n${report}`,
    `[{"code":2}]\n${report}`,
    `build complete\n`,
  ])
    expect(parseCoverageReport(text, 0)).toHaveProperty("error");
  expect(parseCoverageReport(`build\n${report}`, 1)).toHaveProperty("error");
  expect(
    parseCoverageReport(
      `build\n${JSON.stringify({ code: 0, armed: true, coverage: [], uncoveredPaths: [] })}`,
      0,
    ),
  ).toHaveProperty("error");
});
