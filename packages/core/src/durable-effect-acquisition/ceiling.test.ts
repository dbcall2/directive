import { describe, expect, it } from "vitest";
import { evaluateArming, parsePresentationCeiling } from "./ceiling.js";
import { PRESENTATION_CEILING_SCHEMA } from "./types.js";

const base = {
  schema: PRESENTATION_CEILING_SCHEMA,
  changeClass: "presentation" as const,
};

describe("presentation ceiling consume/arming (#5080)", () => {
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
