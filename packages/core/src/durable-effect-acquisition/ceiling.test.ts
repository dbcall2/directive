import { describe, expect, it } from "vitest";
import {
  allowlistsDiffer,
  ceilingIsTightening,
  ceilingIsWeaker,
  combineCeilings,
  emptyAmendments,
  evaluateArming,
  loadCeilingFromMap,
  parsePresentationCeiling,
} from "./ceiling.js";
import { PRESENTATION_CEILING_SCHEMA } from "./types.js";

const base = {
  schema: PRESENTATION_CEILING_SCHEMA,
  changeClass: "presentation" as const,
};

describe("presentation ceiling consume/arming (#5080)", () => {
  it("distinguishes unrelated records, malformed records, and tightening", () => {
    for (const raw of [
      { plan: { metadata: {} } },
      { plan: {} },
      { plan: { "x-directive/changeClass": 42 } },
      { changeClass: 42 },
      { changeClass: "functional" },
    ])
      expect("error" in parsePresentationCeiling(JSON.stringify(raw))).toBe(true);
    expect(
      loadCeilingFromMap(
        new Map([
          [
            "xbrief/active/a.xbrief.json",
            JSON.stringify({ plan: { "x-directive/changeClass": 42 } }),
          ],
        ]),
      ).ok,
    ).toBe(false);
    expect(evaluateArming(null, null, null).armed).toBe(false);
    expect(ceilingIsTightening(null, base)).toBe(true);
    expect(ceilingIsTightening(base, null)).toBe(false);
    const wide = { ...base, admittedGlobals: [{ name: "custom", members: ["read", "write"] }] };
    const tight = { ...base, admittedGlobals: [{ name: "custom", members: ["read"] }] };
    expect(ceilingIsWeaker(base, wide)).toBe(true);
    expect(ceilingIsWeaker(tight, wide)).toBe(true);
    expect(ceilingIsWeaker(wide, tight)).toBe(false);
    expect(ceilingIsTightening(wide, tight)).toBe(true);
  });
  const humanApproval = {
    kind: "human",
    actor: "David",
    mintedAt: "2026-09-28T00:00:00Z",
    mintedVia: "in-harness-ask",
  };
  it.each([
    null,
    [],
    42,
    { ...base, schema: "bad" },
    { ...base, admittedOrigins: "https://a.test" },
    { ...base, admittedPackages: [1] },
    { ...base, admittedPaths: ["../secret"] },
    { ...base, admittedPaths: ["/absolute"] },
    { ...base, admittedOrigins: ["https://a.test/path"] },
    { ...base, admittedOrigins: ["invalid"] },
    { ...base, admittedGlobals: [{ name: "document" }] },
    { ...base, admittedGlobals: [{ name: "x", members: [1] }] },
    { ...base, admittedGlobals: "x" },
    { ...base, humanOrigin: "yes" },
    { ...base, extraExtensions: [".ts"] },
    { ...base, humanApproval: { ...humanApproval, actor: "agent:worker" } },
    { ...base, humanApproval: { ...humanApproval, mintedAt: "bad" } },
  ])("refuses malformed or unsupported ceiling %j", (record) => {
    expect("error" in parsePresentationCeiling(JSON.stringify(record))).toBe(true);
  });
  it("ignores bare origin flags and grants only typed human approval", () => {
    expect(
      emptyAmendments({ ...base, humanOrigin: true, admittedOrigins: ["https://a.test"] }).origins,
    ).toEqual([]);
    expect(
      emptyAmendments({ ...base, humanOrigin: false, admittedOrigins: ["https://a.test"] }).origins,
    ).toEqual([]);
    const parsed = parsePresentationCeiling(
      JSON.stringify({
        ...base,
        humanApproval,
        admittedOrigins: ["https://a.test"],
        admittedPackages: ["clsx"],
        admittedGlobals: [{ name: "custom", members: [] }],
        admittedPaths: ["src/helper.ts"],
      }),
    );
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(emptyAmendments(parsed)).toEqual({
      origins: ["https://a.test"],
      packages: ["clsx"],
      globals: [{ name: "custom", members: [] }],
      paths: ["src/helper.ts"],
    });
  });
  it("combines all restrictions and keeps member grants explicit", () => {
    const a = {
      ...base,
      humanApproval,
      admittedOrigins: ["https://a.test", "https://b.test"],
      admittedGlobals: [{ name: "custom", members: ["read", "write"] }],
    };
    const b = {
      ...base,
      humanApproval,
      admittedOrigins: ["https://a.test"],
      admittedGlobals: [{ name: "custom", members: ["read"] }],
    };
    const r = combineCeilings([a, b]);
    expect(r?.admittedOrigins).toEqual(["https://a.test"]);
    expect(r?.admittedGlobals).toEqual([{ name: "custom", members: ["read"] }]);
    expect(combineCeilings([a, base])?.admittedGlobals).toEqual([]);
    expect(
      allowlistsDiffer(a, {
        ...a,
        admittedOrigins: ["https://b.test", "https://a.test"],
        admittedGlobals: [{ members: ["write", "read"], name: "custom" }],
      }),
    ).toBe(false);
    expect(combineCeilings([])).toBeNull();
  });
  it("loads every supported record instead of selecting the first", () => {
    const loaded = loadCeilingFromMap(
      new Map([
        [
          ".deft/presentation-ceiling.json",
          JSON.stringify({ ...base, humanApproval, admittedOrigins: ["https://a.test"] }),
        ],
        [
          "xbrief/active/a.xbrief.json",
          JSON.stringify({ plan: { "x-directive/changeClass": "presentation" } }),
        ],
        [
          "xbrief/active/b.xbrief.json",
          JSON.stringify({ plan: { "x-directive/changeClass": "functional" } }),
        ],
      ]),
    );
    expect(loaded.ok && loaded.records.size).toBe(2);
    expect(loaded.ok && loaded.ceiling?.admittedOrigins).toEqual([]);
    expect(loadCeilingFromMap(new Map([[".deft/presentation-ceiling.json", "{"]])).ok).toBe(false);
    expect(loadCeilingFromMap(new Map([[".deft/presentation-ceiling.json", "null"]])).ok).toBe(
      false,
    );
    expect(loadCeilingFromMap(new Map([[".deft/presentation-ceiling.json", "{}"]])).ok).toBe(false);
  });
  it("parses a valid presentation ceiling and refuses the wrong schema", () => {
    const ok = parsePresentationCeiling(JSON.stringify(base));
    expect("error" in ok).toBe(false);
    const bad = parsePresentationCeiling(
      JSON.stringify({ schema: "nope", changeClass: "presentation" }),
    );
    expect("error" in bad).toBe(true);
  });

  it("arms from merge-base and cannot disarm by head deletion", () => {
    const parsed = parsePresentationCeiling(JSON.stringify(base));
    if ("error" in parsed) throw new Error(parsed.error);
    const armed = evaluateArming(parsed, null, ".deft/presentation-ceiling.json");
    expect(armed.armed).toBe(true);
    expect(armed.samePrWeaken).toBe(true);
  });

  it("arms add-only head restrictions and flags allowlist widening", () => {
    const parsed = parsePresentationCeiling(JSON.stringify(base));
    if ("error" in parsed) throw new Error(parsed.error);
    const add = evaluateArming(null, parsed, ".deft/presentation-ceiling.json");
    expect(add.armed).toBe(true);
    expect(add.reason).toMatch(/add-only/);
    const wide = parsePresentationCeiling(
      JSON.stringify({ ...base, admittedOrigins: ["https://example.com"] }),
    );
    if ("error" in wide) throw new Error(wide.error);
    const weaken = evaluateArming(parsed, wide, ".deft/presentation-ceiling.json");
    expect(weaken.samePrAllowlistEdit).toBe(true);
    expect(weaken.armed).toBe(true);
  });

  it("flags same-PR allowlist tightening as a rewrite", () => {
    const wide = parsePresentationCeiling(
      JSON.stringify({ ...base, admittedOrigins: ["https://example.com"] }),
    );
    if ("error" in wide) throw new Error(wide.error);
    const tight = parsePresentationCeiling(JSON.stringify(base));
    if ("error" in tight) throw new Error(tight.error);
    const recut = evaluateArming(wide, tight, ".deft/presentation-ceiling.json");
    expect(recut.armed).toBe(true);
    expect(recut.samePrAllowlistEdit).toBe(true);
  });
});
